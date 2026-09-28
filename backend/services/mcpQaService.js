const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const aiUsage = require("./aiUsageService.js");

const McpQaRun = require("../model/McpQaRunModel.js");
const McpBug = require("../model/McpBugModel.js");
const McpTool = require("../model/McpToolModel.js");
const McpDoc = require("../model/McpDocModel.js");
const mcpLab = require("./mcpLabService.js");
const mcpDocs = require("./mcpDocService.js");
const { publicServerUrl } = require("./mcpProjectService.js");

let _openai = null;
let _anthropic = null;

function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPEN_IA || process.env.OPENAI_API_KEY });
  }
  return _openai;
}

function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || "missing",
    });
  }
  // Metered: every call through the platform key is priced and recorded, so
  // no service can spend Olivia's money invisibly (see aiUsageService).
  return aiUsage.meter(_anthropic, { payer: "platform", action: "mcp_bug_hunter", surface: "mcp" });
}

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MCP_QA_MODEL || "gpt-4o";
const DEFAULT_CLAUDE_MODEL = process.env.CLAUDE_MCP_QA_MODEL || "claude-sonnet-4-6";

const QA_CASE_SYSTEM = `You are an expert QA engineer for MCP servers.
Create executable test cases for MCP tools. Return STRICT JSON:
{
  "cases": [
    {
      "name": string,
      "category": "happy_path" | "sad_path" | "boundary" | "security" | "schema",
      "toolName": string,
      "args": object,
      "expectedBehavior": string,
      "severityHint": "low" | "medium" | "high" | "critical"
    }
  ]
}

Rules:
- Cases must call a concrete existing toolName.
- Args must match the target category.
- Include happy path, sad path, boundary, security, and schema tests when possible.
- Use supplied sampleArgsByTool for valid happy paths.
- Do not invent real IDs beyond supplied sample args.
- If an "alreadyTested" list is provided, it holds scenarios from previous runs. Keep essential happy-path coverage, but PRIORITIZE NEW angles/edge cases not in that list — do not just regenerate the same cases.`;

const QA_JUDGE_SYSTEM = `You are an MCP QA bug judge.
You receive one executed MCP tool test: case, tool schema, args, raw response, parsed response, status, and error.
Return STRICT JSON:
{
  "verdict": "pass" | "fail" | "warn",
  "bug": null | {
    "severity": "low" | "medium" | "high" | "critical",
    "category": string,
    "title": string,
    "description": string,
    "expected": string,
    "actual": string,
    "evidence": string,
    "recommendation": string
  },
  "reasoning": string
}

Rules:
- If the behavior clearly violates expectedBehavior or accepts dangerous invalid input, return fail with a concrete bug.
- If the case expected rejection and the tool returns success-like data, that is a bug.
- If the tool correctly rejects invalid/security/boundary args, pass.
- Use the actual response/error as evidence. Do not speculate beyond the evidence.`;

function safeParseJson(txt) {
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (_) {
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (_) {
      return null;
    }
  }
}

function schemaType(schema = {}) {
  if (Array.isArray(schema.type)) return schema.type[0];
  if (schema.type) return schema.type;
  if (schema.enum) return "string";
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "string";
}

function mutateValueForCategory(schema = {}, category) {
  const type = schemaType(schema);
  if (category === "security") {
    if (type === "string") return "' OR '1'='1";
    if (type === "object") return { $ne: null };
    if (type === "array") return [{ $ne: null }];
    return "<script>alert(1)</script>";
  }
  if (category === "boundary") {
    if (type === "string") return "";
    if (type === "number" || type === "integer") return Number.MAX_SAFE_INTEGER;
    if (type === "array") return [];
    if (type === "boolean") return false;
    return {};
  }
  if (category === "schema") {
    if (type === "string") return { invalid: true };
    if (type === "number" || type === "integer") return "not-a-number";
    if (type === "boolean") return "not-a-boolean";
    if (type === "array") return "not-an-array";
    if (type === "object") return "not-an-object";
  }
  return undefined;
}

function requiredFields(tool) {
  return tool.inputSchema?.required || [];
}

function fallbackCasesForTool(tool, sampleArgs = {}) {
  const properties = tool.inputSchema?.properties || {};
  const required = requiredFields(tool);
  const cases = [
    {
      name: `${tool.name} happy path`,
      category: "happy_path",
      toolName: tool.name,
      args: sampleArgs,
      expectedBehavior: "Tool should complete successfully and return a valid MCP response.",
      severityHint: "medium",
    },
  ];

  if (required.length) {
    const missingField = required[0];
    const args = { ...sampleArgs };
    delete args[missingField];
    cases.push({
      name: `${tool.name} missing required ${missingField}`,
      category: "sad_path",
      toolName: tool.name,
      args,
      expectedBehavior: `Tool should reject missing required argument "${missingField}".`,
      severityHint: "medium",
    });
  }

  const firstField = Object.keys(properties)[0];
  if (firstField) {
    cases.push({
      name: `${tool.name} boundary input`,
      category: "boundary",
      toolName: tool.name,
      args: {
        ...sampleArgs,
        [firstField]: mutateValueForCategory(properties[firstField], "boundary"),
      },
      expectedBehavior: "Tool should handle boundary input safely without leaking internals or returning invalid success data.",
      severityHint: "medium",
    });
    cases.push({
      name: `${tool.name} schema violation`,
      category: "schema",
      toolName: tool.name,
      args: {
        ...sampleArgs,
        [firstField]: mutateValueForCategory(properties[firstField], "schema"),
      },
      expectedBehavior: "Tool should reject arguments that violate its declared input schema.",
      severityHint: "high",
    });
    cases.push({
      name: `${tool.name} injection probe`,
      category: "security",
      toolName: tool.name,
      args: {
        ...sampleArgs,
        [firstField]: mutateValueForCategory(properties[firstField], "security"),
      },
      expectedBehavior: "Tool should reject or safely handle injection-style input without returning unauthorized data.",
      severityHint: "high",
    });
  }

  return cases;
}

function fallbackCases({ tools, sampleArgsByTool = {}, maxCasesPerTool = 5 }) {
  return (tools || []).flatMap((tool) =>
    fallbackCasesForTool(
      tool,
      sampleArgsByTool[tool.name] || mcpDocs.sampleArgsFromSchema(tool.inputSchema || {})
    ).slice(0, maxCasesPerTool)
  );
}

async function callJsonLLM({ provider, model, system, user, maxTokens = 4096, anthropicClient = null }) {
  const chosenProvider = provider || "anthropic";
  const chosenModel =
    model || (chosenProvider === "anthropic" ? DEFAULT_CLAUDE_MODEL : DEFAULT_OPENAI_MODEL);

  if (chosenProvider === "openai") {
    const completion = await getOpenAI().chat.completions.create({
      model: chosenModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return {
      parsed: safeParseJson(completion.choices?.[0]?.message?.content),
      model: chosenModel,
    };
  }

  if (chosenProvider === "anthropic") {
    const client = aiUsage.tag(anthropicClient || getAnthropic(), { action: "mcp_bug_hunter", surface: "mcp" });
    const msg = await client.messages.create({
      model: chosenModel,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    const raw = (msg.content || []).map((c) => c.text || "").join("\n");
    return { parsed: safeParseJson(raw), model: chosenModel };
  }

  throw new Error(`Unknown provider: ${chosenProvider}`);
}

async function generateCases({ tools, docs, sampleArgsByTool, provider, model, maxCasesPerTool, anthropicClient = null, priorCases = [] }) {
  const fallback = fallbackCases({ tools, sampleArgsByTool, maxCasesPerTool });
  try {
    const { parsed, model: chosenModel } = await callJsonLLM({
      provider,
      model,
      system: QA_CASE_SYSTEM,
      user: JSON.stringify(
        {
          tools,
          docs,
          sampleArgsByTool,
          maxCasesPerTool,
          ...(priorCases.length ? { alreadyTested: priorCases } : {}),
        },
        null,
        2
      ),
      anthropicClient,
    });
    const generated = Array.isArray(parsed?.cases) ? parsed.cases : [];
    const toolNames = new Set((tools || []).map((tool) => tool.name));
    const valid = generated.filter((testCase) => toolNames.has(testCase.toolName));
    return { cases: valid.length ? valid : fallback, model: chosenModel, usedFallback: !valid.length };
  } catch (err) {
    return { cases: fallback, model: null, usedFallback: true, generationError: err.message };
  }
}

// Required arguments that name an identifier (id, product_id, orderId…). These
// can't be invented: a made-up id legitimately comes back "not found".
function idLikeRequiredArgs(tool) {
  const schema = tool?.inputSchema || {};
  const required = new Set(schema.required || []);
  return Object.keys(schema.properties || {}).filter(
    (name) => required.has(name) && /(^id$|_id$|Id$)/.test(name)
  );
}

// True when the case ran on an id nobody has verified exists.
//
// Checks the args the case ACTUALLY USED, not just whether a real value was
// on offer: the generator can be handed product_id=1 and still write a "second
// known product" happy path with product_id=2. That id was invented, so its
// "not found" means nothing about the tool.
function ranBlindOnIds(tool, knownArgs, usedArgs) {
  const ids = idLikeRequiredArgs(tool);
  if (!ids.length) return false;
  const known = knownArgs || {};
  const used = usedArgs || {};
  return ids.some((name) => {
    const k = known[name];
    if (k === undefined || k === null || k === "") return true;
    // Compare as strings so 1 and "1" count as the same verified id.
    return String(used[name]) !== String(k);
  });
}

function fallbackJudge(testCase, execution) {
  const expectedRejection = ["sad_path", "security", "schema"].includes(testCase.category);
  const passed = expectedRejection ? execution.status !== "ok" || !!execution.error : execution.status === "ok" && !execution.error;
  if (passed) {
    return { verdict: "pass", bug: null, reasoning: "Fallback judge matched the expected status pattern." };
  }

  return {
    verdict: "fail",
    reasoning: "Fallback judge found behavior that conflicts with the case expectation.",
    bug: {
      severity: testCase.severityHint || "medium",
      category: testCase.category,
      title: `${testCase.toolName} failed ${testCase.category} test`,
      description: `The tool behavior did not match: ${testCase.expectedBehavior}`,
      expected: testCase.expectedBehavior,
      actual: execution.error || JSON.stringify(execution.response),
      evidence: JSON.stringify({ args: testCase.args, response: execution.response, error: execution.error }),
      recommendation: "Inspect input validation and tool response handling for this case.",
    },
  };
}

async function judgeCase({ testCase, tool, execution, provider, model, anthropicClient = null }) {
  try {
    const { parsed } = await callJsonLLM({
      provider,
      model,
      system: QA_JUDGE_SYSTEM,
      user: JSON.stringify({ testCase, tool, execution }, null, 2),
      maxTokens: 2048,
      anthropicClient,
    });
    if (parsed?.verdict) return parsed;
    return fallbackJudge(testCase, execution);
  } catch (_) {
    return fallbackJudge(testCase, execution);
  }
}

// Compact list of cases already tried in recent QA runs (from McpQaRun.cases),
// optionally scoped to a single tool. No extra storage — reads what we persist.
async function fetchPriorMcpCases({ projectId, companyId, toolName, limit = 40 }) {
  if (!projectId) return [];
  const query = companyId ? { projectId, companyId } : { projectId };
  const runs = await McpQaRun.find(query)
    .sort({ createdAt: -1 })
    .limit(3)
    .select("cases")
    .lean();

  const seen = new Set();
  const prior = [];
  for (const run of runs) {
    for (const c of run.cases || []) {
      if (toolName && c.toolName !== toolName) continue;
      const key = `${c.toolName}::${(c.name || "").trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      prior.push({
        toolName: c.toolName,
        name: c.name,
        category: c.category || null,
        expectedBehavior: c.expectedBehavior || "",
      });
      if (prior.length >= limit) return prior;
    }
  }
  return prior;
}

async function runQa({
  config,
  projectId,
  toolName,
  provider = "anthropic",
  model,
  save = true,
  userId,
  companyId,
  sampleArgsByTool = {},
  maxCasesPerTool = 5,
  anthropicClient = null,
}) {
  const allTools = await mcpLab.listTools(config);
  const tools = toolName
    ? allTools.filter((t) => t.name === toolName)
    : allTools;
  if (toolName && !tools.length) {
    throw new Error(`Tool "${toolName}" not found on server`);
  }
  const projectScopedQuery = companyId ? { projectId, companyId } : { projectId };
  const [projectTools, projectDocs] = projectId
    ? await Promise.all([
        McpTool.find(projectScopedQuery),
        McpDoc.find(projectScopedQuery),
      ])
    : [[], []];
  const toolByName = new Map(projectTools.map((tool) => [tool.name, tool]));
  const docByToolName = new Map(projectDocs.map((doc) => [doc.toolName, doc]));
  const serverName = config.name || config.url || "unnamed";
  const docs = await mcpDocs.listDocs({
    projectId,
    serverName,
    serverUrl: publicServerUrl(config.url),
    companyId,
    limit: 500,
  });
  // What earlier runs already covered on this project/tool, so this run pushes
  // into new scenarios instead of regenerating the same cases.
  const priorCases = await fetchPriorMcpCases({ projectId, companyId, toolName });
  console.log(
    `[dedup][mcp] tool=${toolName || "all"} priorCases=${priorCases.length}`,
    priorCases.map((c) => `${c.toolName}:${c.name}`)
  );
  const generated = await generateCases({
    tools,
    docs,
    sampleArgsByTool,
    provider,
    model,
    maxCasesPerTool,
    anthropicClient,
    priorCases,
  });
  console.log(
    `[dedup][mcp] generated ${generated.cases.length} cases`,
    generated.cases.map((c) => `${c.toolName}:${c.name}`)
  );

  const results = [];
  const bugs = [];

  for (const testCase of generated.cases) {
    const tool = tools.find((item) => item.name === testCase.toolName);
    const started = Date.now();
    const run = await mcpLab.invokeTool({
      config,
      toolName: testCase.toolName,
      args: testCase.args || {},
      saveTrace: false,
      tags: ["mcp-qa"],
      userId,
      companyId,
    });
    const parsedResponse = mcpDocs.extractToolResponseJson(run.toolResponse);
    const execution = {
      status: run.status,
      error: run.error,
      latencyMs: Date.now() - started,
      args: testCase.args || {},
      response: parsedResponse,
      rawToolResponse: run.toolResponse,
      responseSchema: run.status === "ok" && !run.error ? mcpDocs.inferJsonSchema(parsedResponse) : null,
    };
    let judged = await judgeCase({ testCase, tool, execution, provider, model, anthropicClient });

    // Missing-data guard — the MCP counterpart of the API happy-path guard.
    // A happy path for a tool that needs a real id (product_id, order_id…) only
    // means something with an id that exists. When none was supplied, the
    // generator invents one, the tool correctly answers "not found", and the
    // judge files a bug against a tool that works fine. Downgrade that to a
    // needs-data warning — it removes false bugs and never hides a real one,
    // since a happy path WITH a known id is judged exactly as before.
    if (
      testCase.category === "happy_path" &&
      judged.verdict !== "pass" &&
      ranBlindOnIds(tool, sampleArgsByTool[testCase.toolName], testCase.args)
    ) {
      judged = {
        verdict: "warn",
        bug: null,
        reasoning:
          "Needs data: this tool requires a real id and none was available, so the call used an invented value. " +
          "The failure says nothing about the tool — give it sample args with a real id to test the happy path.",
      };
    }
    const result = {
      ...testCase,
      execution,
      verdict: judged.verdict,
      reasoning: judged.reasoning,
      bug: judged.bug || null,
    };
    results.push(result);

    if (judged.bug) {
      const projectTool = toolByName.get(testCase.toolName);
      const projectDoc = docByToolName.get(testCase.toolName);
      bugs.push({
        id: `${testCase.toolName}:${testCase.category}:${bugs.length + 1}`,
        toolId: projectTool?._id,
        docId: projectDoc?._id,
        toolName: testCase.toolName,
        testCaseName: testCase.name,
        args: testCase.args || {},
        response: parsedResponse,
        rawToolResponse: run.toolResponse,
        ...judged.bug,
      });
    }
  }

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.verdict === "pass").length,
    failed: results.filter((r) => r.verdict === "fail").length,
    warned: results.filter((r) => r.verdict === "warn").length,
    bugs: bugs.length,
  };

  const payload = {
    server: {
      name: serverName,
      url: config.url,
      transport: config.transport || "http",
    },
    summary,
    cases: generated.cases,
    results,
    bugs,
    generatedBy: {
      provider: generated.model ? provider : "none",
      model: generated.model,
      usedFallback: generated.usedFallback,
      generationError: generated.generationError,
    },
  };

  if (save) {
    const saved = await McpQaRun.create({
      projectId,
      serverName,
      serverUrl: publicServerUrl(config.url),
      transport: config.transport || "http",
      summary,
      cases: generated.cases,
      results,
      bugs,
      generatedBy: payload.generatedBy,
      userId,
      companyId,
    });
    payload.runId = saved._id;

    if (bugs.length) {
      await McpBug.insertMany(
        bugs.map((bug) => ({
          ...bug,
          projectId,
          toolId: bug.toolId,
          docId: bug.docId,
          qaRunId: saved._id,
          serverName,
          serverUrl: publicServerUrl(config.url),
          transport: config.transport || "http",
          status: "open",
          userId,
          companyId,
        }))
      );
    }
  }

  return payload;
}

module.exports = {
  runQa,
  callJsonLLM,
  safeParseJson,
  idLikeRequiredArgs,
  ranBlindOnIds,
};
