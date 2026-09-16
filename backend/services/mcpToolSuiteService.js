const McpProject = require("../model/McpProjectModel.js");
const McpTool = require("../model/McpToolModel.js");
const McpDoc = require("../model/McpDocModel.js");
const McpToolSuite = require("../model/McpToolSuiteModel.js");
const mcpProjects = require("./mcpProjectService.js");
const mcpLab = require("./mcpLabService.js");
const Anthropic = require("@anthropic-ai/sdk");

// Saved smoke / regression suites for MCP tools — the counterpart of
// apiSuiteService on the API side, and deliberately the same shape so both
// halves of the product behave identically.
//
// The older mcpSmokeService generates every tool's cases in ONE call to the
// model, capped at 4096 output tokens. That is fine for three tools, truncates
// around forty, and cannot work at two hundred: the response is cut off and the
// whole project's suite is lost. Here each tool is its own call, so cost and
// output scale linearly and one bad tool doesn't sink the rest.

const CLAUDE_MODEL = process.env.CLAUDE_QA_MODEL || "claude-opus-4-7";

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "missing" });
  }
  return _anthropic;
}

function safeParseJson(txt) {
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (_) {
    const m = txt.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

function extractText(resp) {
  return (resp?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// MCP tools have no sections, so the tests page would show one flat list of
// hundreds. Group by the tool's name prefix instead — "orders_list" and
// "orders_create" land together under "orders", the same way API endpoints get
// a section derived from their path.
function groupForTool(toolName) {
  const n = String(toolName || "");
  const m = n.match(/^([a-z0-9]+)[_.\-/]/i);
  if (m) return m[1].toLowerCase();
  // camelCase: listOrders -> list
  const camel = n.match(/^([a-z]+)[A-Z]/);
  if (camel) return camel[1].toLowerCase();
  return "general";
}

const SMOKE_SYSTEM = `You write ONE smoke test for a single MCP tool: the happy path that answers "is this tool alive and doing its job?".

Return STRICT JSON only:
{
  "cases": [
    {
      "name": "short descriptive name",
      "covers": "ONE plain sentence a non-technical QA lead can read, describing what this test verifies",
      "category": "happy_path",
      "args": { },
      "assertions": ["plain-English checks on the response"],
      "expectError": false
    }
  ]
}

Rules:
- EXACTLY one case: the realistic success scenario.
- "args" MUST validate against the tool's inputSchema — every required field present, correct types, valid enum values.
- Prefer values from sampleArgs or the examples when given; they are known to work.
- 2 to 4 assertions, concrete and checkable from the response alone.
- Return only the JSON object.`;

const REGRESSION_SYSTEM = `You write a REGRESSION suite for a single MCP tool: the checks that must keep behaving the same over time. Re-run later, any deviation is a regression.

Return STRICT JSON only:
{
  "cases": [
    {
      "name": "short descriptive name",
      "covers": "ONE plain sentence a non-technical QA lead can read, describing what this test verifies",
      "category": "happy_path | missing_required | wrong_type | boundary | error_handling",
      "args": { },
      "assertions": ["plain-English checks on the response"],
      "expectError": false
    }
  ]
}

Rules:
- Between 3 and 6 cases. Always include the happy path.
- Then cover the contract that must not silently change: a missing required field, a wrong type, and a boundary if the schema has one.
- For a case where the tool SHOULD reject the input, set "expectError": true. The tool erroring is then the PASS.
- The happy path's "args" must validate against the inputSchema; the negative cases break it on purpose, one thing at a time.
- Every case needs a "covers" sentence and 1 to 4 assertions.
- Each assertion MUST be decidable from THIS single response alone. Never write
  checks about stability across runs, performance over time, or anything needing
  a second call — a judge looking at one response can only mark those as failed,
  which turns a passing tool red for no reason.
- Return only the JSON object.`;

async function loadToolForCompany({ projectId, toolName, companyId }) {
  const tool = await McpTool.findOne({ projectId, name: toolName, companyId });
  if (!tool) {
    const err = new Error(`Tool "${toolName}" not found in this project`);
    err.statusCode = 404;
    throw err;
  }
  return tool;
}

/**
 * Generate (or regenerate) one kind of suite for ONE tool.
 * Replaces any existing suite of that kind for the tool.
 */
async function generateSuite({
  projectId,
  toolName,
  kind,
  userId,
  companyId,
  anthropicClient = null,
}) {
  if (!["smoke", "regression"].includes(kind)) {
    const err = new Error(`Unknown suite kind "${kind}"`);
    err.statusCode = 400;
    throw err;
  }
  const project = await McpProject.findOne({ _id: projectId, companyId });
  if (!project) {
    const err = new Error("MCP project not found");
    err.statusCode = 404;
    throw err;
  }
  const tool = await loadToolForCompany({ projectId, toolName, companyId });
  const doc = await McpDoc.findOne({ projectId, toolName, companyId });

  const client = anthropicClient || getAnthropic();
  const resp = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 3000,
    system: kind === "smoke" ? SMOKE_SYSTEM : REGRESSION_SYSTEM,
    messages: [
      {
        role: "user",
        content: `TOOL:\n${JSON.stringify(
          {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            sampleArgs: doc?.sampleArgs || null,
            summary: doc?.summary || null,
            examples: doc?.examples || [],
          },
          null,
          2
        )}`,
      },
    ],
  });

  const parsed = safeParseJson(extractText(resp));
  const raw = Array.isArray(parsed?.cases) ? parsed.cases : [];
  if (!raw.length) {
    const err = new Error(
      `The generator returned no test cases for "${toolName}". Try again.`
    );
    err.statusCode = 502;
    throw err;
  }

  const cases = raw.map((c) => ({
    name: c.name || `${toolName} ${kind}`,
    covers: c.covers || "",
    category: c.category || "happy_path",
    args: c.args || {},
    assertions: Array.isArray(c.assertions) ? c.assertions : [],
    expectError: Boolean(c.expectError),
  }));

  return McpToolSuite.findOneAndUpdate(
    { projectId, toolName, kind },
    {
      $set: {
        projectId,
        toolName,
        group: groupForTool(toolName),
        kind,
        cases,
        generatedBy: { provider: "anthropic", model: CLAUDE_MODEL },
        userId,
        companyId,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

/**
 * Generate both kinds for every tool in a project — the "do it all" button.
 *
 * Sequential on purpose: one model call per tool per kind, and firing two
 * hundred at once is how you get rate-limited into failing the whole batch.
 * Partial failures are reported rather than thrown, so 199 good tools are not
 * lost to one bad schema.
 */
async function generateProjectSuites({
  projectId,
  toolNames = null,
  kinds = ["smoke", "regression"],
  userId,
  companyId,
  anthropicClient = null,
  onProgress = null,
}) {
  const query = { projectId, companyId };
  if (toolNames?.length) query.name = { $in: toolNames };
  const tools = await McpTool.find(query).sort({ name: 1 }).lean();

  const created = [];
  const failed = [];
  let done = 0;
  for (const tool of tools) {
    for (const kind of kinds) {
      try {
        const suite = await generateSuite({
          projectId,
          toolName: tool.name,
          kind,
          userId,
          companyId,
          anthropicClient,
        });
        created.push({ toolName: tool.name, kind, cases: suite.cases.length });
      } catch (err) {
        console.error(
          `[mcp-suite] generate failed ${tool.name} (${kind}):`,
          err.message
        );
        failed.push({ toolName: tool.name, kind, error: err.message });
      }
    }
    done += 1;
    if (onProgress) onProgress({ done, total: tools.length });
  }
  return { created, failed, tools: tools.length };
}

// Shallow key list of a tool result — enough to notice "the response lost a
// field" without storing the whole payload as a baseline.
function resultKeysOf(result) {
  const content = result?.content;
  if (Array.isArray(content)) {
    const first = content.find((c) => c && typeof c === "object");
    return first ? Object.keys(first).sort() : [];
  }
  if (result && typeof result === "object") return Object.keys(result).sort();
  return [];
}

const JUDGE_SYSTEM = `You check whether an MCP tool's response satisfies plain-English assertions.

You receive the tool's schema, the arguments it was called with, the response, and a list of assertions.

Return STRICT JSON only:
{
  "results": [
    { "assertion": "copied verbatim from the input", "passed": true, "reason": "one short sentence" }
  ]
}

Rules:
- One entry per assertion, in the same order, with the assertion text copied verbatim.
- Judge ONLY what the response actually shows. If it cannot confirm the assertion, it did not pass.
- "reason" is one short sentence, quoting the evidence when useful.
- Return only the JSON object.`;

function truncate(value, max = 4000) {
  if (value == null) return null;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + `… [truncated ${s.length - max} chars]` : s;
}

async function judgeAssertions({ tool, args, result, assertions, client }) {
  if (!assertions.length) return [];
  const resp = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    system: JUDGE_SYSTEM,
    messages: [
      {
        role: "user",
        content: JSON.stringify(
          {
            tool: { name: tool.name, description: tool.description },
            args,
            response: truncate(result),
            assertions,
          },
          null,
          2
        ),
      },
    ],
  });
  const parsed = safeParseJson(extractText(resp));
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  // A malformed judge reply must never silently pass a case.
  return assertions.map((a, i) => {
    const r = results[i] || {};
    return {
      assertion: a,
      passed: r.passed === true,
      reason: r.reason || (results[i] ? "" : "The judge returned no verdict."),
    };
  });
}

/**
 * Run every case in a suite against the live MCP server.
 *
 * NOTE: this invokes the customer's tools for real. A tool that writes or
 * deletes will do so.
 */
async function runSuite({ suiteId, companyId, anthropicClient = null }) {
  const suite = await McpToolSuite.findOne({ _id: suiteId, companyId });
  if (!suite) {
    const err = new Error("Suite not found");
    err.statusCode = 404;
    throw err;
  }
  const tool = await loadToolForCompany({
    projectId: suite.projectId,
    toolName: suite.toolName,
    companyId,
  });
  const { config } = await mcpProjects.resolveConfig({
    projectId: suite.projectId,
    companyId,
  });
  const client = anthropicClient || getAnthropic();

  const results = [];
  for (const c of suite.cases) {
    const invocation = await mcpLab.invokeTool({
      config,
      toolName: suite.toolName,
      args: c.args || {},
      saveTrace: false,
      companyId,
      userId: suite.userId,
    });

    const errored =
      invocation.status === "error" || invocation.toolResponse?.isError === true;
    // An error-handling case expects a rejection, so erroring IS the pass.
    const outcomeOk = c.expectError ? Boolean(errored) : !errored;

    const assertionResults = outcomeOk
      ? await judgeAssertions({
          tool,
          args: c.args,
          result: invocation.toolResponse ?? invocation.error,
          assertions: c.assertions || [],
          client,
        })
      : (c.assertions || []).map((a) => ({
          assertion: a,
          passed: false,
          reason: c.expectError
            ? "The tool accepted input it should have rejected."
            : "The tool call failed, so nothing could be checked.",
        }));
    const assertionsOk = assertionResults.every((r) => r.passed);

    const keys = resultKeysOf(invocation.toolResponse);
    const base = c.baseline || {};
    const hasBaseline = Boolean(base.recordedAt);
    const missingKeys = hasBaseline
      ? (base.resultKeys || []).filter((k) => !keys.includes(k))
      : [];
    const errorDrift =
      hasBaseline && base.isError != null && base.isError !== Boolean(errored);
    const isRegression = hasBaseline && (errorDrift || missingKeys.length > 0);

    const passed = outcomeOk && assertionsOk;

    if (passed && !hasBaseline) {
      c.baseline = {
        isError: Boolean(errored),
        resultKeys: keys,
        recordedAt: new Date(),
      };
    }

    results.push({
      caseId: String(c._id),
      name: c.name,
      covers: c.covers,
      category: c.category,
      expectError: c.expectError,
      passed,
      isRegression,
      errored: Boolean(errored),
      error: invocation.error || null,
      latencyMs: invocation.latencyMs ?? null,
      assertions: assertionResults,
      regressionDetail: isRegression
        ? [
            errorDrift
              ? `used to ${base.isError ? "error" : "succeed"}, now ${errored ? "errors" : "succeeds"}`
              : "",
            missingKeys.length
              ? `response no longer has: ${missingKeys.join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("; ")
        : "",
    });
  }

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    regressions: results.filter((r) => r.isRegression).length,
  };

  suite.lastRun = {
    at: new Date(),
    passed: summary.passed,
    failed: summary.failed,
    regressions: summary.regressions,
  };
  await suite.save();

  return { suite, summary, results };
}

const REFINE_SYSTEM = `You are editing ONE MCP tool test case based on a user instruction.

You receive the tool schema, the current case, and a natural-language instruction describing how to change what it covers.

Your job is ADDITIVE by default: the user is usually asking to ALSO check something, not to throw away what the case already verifies. NEVER drop an existing assertion unless the instruction EXPLICITLY says to remove, replace, or stop checking it.

Return STRICT JSON only:
{
  "name": "updated descriptive name",
  "covers": "updated ONE-sentence description of what this test verifies, in plain language",
  "args": { },
  "expectError": false,
  "assertionsToAdd": ["brand-new checks to append (may be empty)"],
  "assertionsToRemove": ["ONLY checks the user explicitly asked to remove, copied VERBATIM from the current assertions (usually empty)"]
}

Rules:
- "args" must still validate against the tool's inputSchema, unless the case is deliberately testing invalid input.
- Entries in "assertionsToRemove" MUST match an existing assertion verbatim so it can be removed reliably.
- "covers" must reflect the case AFTER the change, including what was already there.
- Return only the JSON object.`;

const CREATE_SYSTEM = `You write ONE test case for a single MCP tool, from a plain-language instruction.

Return STRICT JSON only:
{
  "name": "short descriptive name",
  "covers": "ONE plain sentence a non-technical QA lead can read, describing what this test verifies",
  "category": "happy_path | missing_required | wrong_type | boundary | error_handling",
  "args": {},
  "assertions": ["plain-English checks on the response"],
  "expectError": false
}

Rules:
- Exactly one case, doing what the instruction asks — nothing more.
- "args" must validate against the tool's inputSchema, unless the case deliberately tests invalid input.
- Set "expectError": true when the tool SHOULD reject the input; the tool erroring is then the PASS.
- 1 to 4 assertions, each decidable from THIS single response alone.
- Return only the JSON object.`;

/**
 * Add ONE case to an existing suite: blank, or written from a sentence. The
 * generators only ever produce a whole suite, so without this a user who wants
 * one more check has to regenerate everything.
 */
async function createCase({
  suiteId,
  companyId,
  instruction = "",
  anthropicClient = null,
}) {
  const suite = await McpToolSuite.findOne({ _id: suiteId, companyId });
  if (!suite) {
    const err = new Error("Suite not found");
    err.statusCode = 404;
    throw err;
  }
  const tool = await loadToolForCompany({
    projectId: suite.projectId,
    toolName: suite.toolName,
    companyId,
  });

  let next = {
    name: "New test",
    covers: "",
    category: "happy_path",
    args: {},
    assertions: [],
    expectError: false,
  };

  if (instruction && instruction.trim()) {
    const client = anthropicClient || getAnthropic();
    const resp = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: CREATE_SYSTEM,
      messages: [
        {
          role: "user",
          content: JSON.stringify(
            {
              tool: {
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                outputSchema: tool.outputSchema,
              },
              instruction: instruction.trim(),
            },
            null,
            2
          ),
        },
      ],
    });
    const parsed = safeParseJson(extractText(resp));
    if (!parsed) {
      const err = new Error("Could not understand it. Try rewording it.");
      err.statusCode = 502;
      throw err;
    }
    next = {
      name: parsed.name || next.name,
      covers: parsed.covers || "",
      category: parsed.category || "happy_path",
      args: parsed.args && typeof parsed.args === "object" ? parsed.args : {},
      assertions: Array.isArray(parsed.assertions) ? parsed.assertions : [],
      expectError: parsed.expectError === true,
    };
  }

  suite.cases.push(next);
  await suite.save();
  return { suite, case: suite.cases[suite.cases.length - 1] };
}

/** Delete ONE case, so a hand-written or badly refined test can be removed. */
async function deleteCase({ suiteId, caseId, companyId }) {
  const suite = await McpToolSuite.findOne({ _id: suiteId, companyId });
  if (!suite) {
    const err = new Error("Suite not found");
    err.statusCode = 404;
    throw err;
  }
  const c = suite.cases.id(caseId);
  if (!c) {
    const err = new Error("Test case not found");
    err.statusCode = 404;
    throw err;
  }
  c.deleteOne();
  await suite.save();
  return { suite };
}

/** Change what one case covers, from a plain instruction. */
async function refineCase({
  suiteId,
  caseId,
  instruction,
  companyId,
  anthropicClient = null,
}) {
  if (!instruction || !instruction.trim()) {
    const err = new Error("Tell us what this test should cover.");
    err.statusCode = 400;
    throw err;
  }
  const suite = await McpToolSuite.findOne({ _id: suiteId, companyId });
  if (!suite) {
    const err = new Error("Suite not found");
    err.statusCode = 404;
    throw err;
  }
  const c = suite.cases.id(caseId);
  if (!c) {
    const err = new Error("Test case not found");
    err.statusCode = 404;
    throw err;
  }
  const tool = await loadToolForCompany({
    projectId: suite.projectId,
    toolName: suite.toolName,
    companyId,
  });

  const client = anthropicClient || getAnthropic();
  const resp = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    system: REFINE_SYSTEM,
    messages: [
      {
        role: "user",
        content: JSON.stringify(
          {
            tool: {
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            },
            currentCase: {
              name: c.name,
              covers: c.covers,
              args: c.args,
              assertions: c.assertions,
              expectError: c.expectError,
            },
            instruction,
          },
          null,
          2
        ),
      },
    ],
  });

  const delta = safeParseJson(extractText(resp));
  if (!delta) {
    const err = new Error("Could not understand the change. Try rewording it.");
    err.statusCode = 502;
    throw err;
  }

  const toRemove = new Set(
    Array.isArray(delta.assertionsToRemove) ? delta.assertionsToRemove : []
  );
  const kept = (c.assertions || []).filter((a) => !toRemove.has(a));
  const added = (Array.isArray(delta.assertionsToAdd) ? delta.assertionsToAdd : []).filter(
    (a) => a && !kept.includes(a)
  );

  c.name = delta.name || c.name;
  c.covers = delta.covers || c.covers;
  if (delta.args !== undefined) c.args = delta.args;
  if (delta.expectError !== undefined) c.expectError = Boolean(delta.expectError);
  c.assertions = [...kept, ...added];

  // What the test checks just changed, so the old baseline describes a
  // different test. Drop it rather than report a bogus regression next run.
  c.baseline = { isError: null, resultKeys: [], recordedAt: null };

  await suite.save();
  return { suite, case: suite.cases.id(caseId), added, removed: [...toRemove] };
}

/** Every suite of a project, ordered so the tests page can group them stably. */
async function listProjectSuites({ projectId, companyId }) {
  const suites = await McpToolSuite.find({ projectId, companyId })
    .sort({ group: 1, toolName: 1, kind: 1 })
    .lean();

  // Same reason as the API side: to write a check on a field you have to know
  // the field exists, so ship each tool's schemas with its tests.
  const tools = await McpTool.find({
    projectId,
    companyId,
    name: { $in: [...new Set(suites.map((s) => s.toolName))] },
  })
    .select("name inputSchema outputSchema")
    .lean();
  const byName = new Map(tools.map((t) => [t.name, t]));
  return suites.map((s) => ({
    ...s,
    inputSchema: byName.get(s.toolName)?.inputSchema || null,
    outputSchema: byName.get(s.toolName)?.outputSchema || null,
  }));
}

module.exports = {
  groupForTool,
  generateSuite,
  createCase,
  deleteCase,
  generateProjectSuites,
  runSuite,
  refineCase,
  listProjectSuites,
};
