/**
 * MCP Lab Service
 * -----------------
 * Core engine to:
 *  1) Connect to arbitrary MCP servers (stdio / streamable HTTP)
 *  2) List tools / resources / prompts
 *  3) Invoke tools and capture traces
 *  4) Run LLM-as-Judge evaluations with OpenAI (GPT) and Anthropic (Claude)
 *  5) Generate test cases from tool schemas
 *
 * NOTE: The MCP SDK ships as ESM but exposes a CJS build under dist/cjs.
 * We require from those CJS paths to stay compatible with the rest of this
 * CommonJS codebase.
 */

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");

const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const aiUsage = require("./aiUsageService.js");

const { McpTrace } = require("../model/mcpTraceModel.js");

function publicServerUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    for (const key of [...parsed.searchParams.keys()]) {
      if (
        /api[-_]?key|access[-_]?token|token|secret|password|bearer|auth/i.test(
          key,
        )
      ) {
        parsed.searchParams.set(key, "***encrypted***");
      }
    }
    return parsed.toString();
  } catch (_) {
    return rawUrl;
  }
}

// -------------------------------------------------------------
// LLM clients (lazy-initialized so missing keys don't crash import)
// Both providers wired, as requested.
// -------------------------------------------------------------
let _openai = null;
let _anthropic = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({
      apiKey: process.env.OPEN_IA || process.env.OPENAI_API_KEY,
    });
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
  return aiUsage.meter(_anthropic, { payer: "platform", action: "mcp_lab", surface: "mcp" });
}

const DEFAULT_OPENAI_MODEL = "gpt-4o";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

// -------------------------------------------------------------
// MCP connection helpers
// -------------------------------------------------------------

/**
 * Build a transport from a config object.
 * config = { transport: "http"|"sse"|"stdio", url?, command?, args?, env?, headers?, bearerToken?, apiKey?, apiKeyHeader? }
 */
function buildTransport(config = {}) {
  const t = (config.transport || "http").toLowerCase();
  if (t === "http" || t === "sse") {
    if (!config.url) throw new Error("MCP http transport requires `url`");
    const headers = buildHttpHeaders(config);
    const parsedUrl = new URL(config.url);

    return new StreamableHTTPClientTransport(parsedUrl, {
      requestInit: { headers },
    });
  }
  if (t === "stdio") {
    if (!config.command)
      throw new Error("MCP stdio transport requires `command`");
    return new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: config.env || process.env,
    });
  }
  throw new Error(`Unsupported MCP transport: ${t}`);
}

function buildHttpHeaders(config = {}) {
  const headers = {};
  if (
    config.headers &&
    typeof config.headers === "object" &&
    !Array.isArray(config.headers)
  ) {
    for (const [key, value] of Object.entries(config.headers)) {
      if (value !== undefined && value !== null) headers[key] = String(value);
    }
  }

  if (config.bearerToken && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${config.bearerToken}`;
  }

  if (config.apiKey) {
    headers[config.apiKeyHeader || "x-api-key"] = String(config.apiKey);
  }

  return headers;
}

/**
 * Open a short-lived MCP connection, run `fn(client)`, then close.
 * Keeps things stateless for HTTP-style usage.
 */
async function withClient(config, fn) {
  const client = new Client(
    { name: "mcp-lab", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = buildTransport(config);
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch (_) {
      /* swallow close errors */
    }
  }
}

/**
 * Open a *persistent* MCP connection for load testing. Unlike `withClient`,
 * this does NOT close after one call — a virtual user connects once, fires many
 * tool calls in a loop, then closes at the end. This measures real tool latency
 * under load instead of per-call connection setup/teardown overhead.
 *
 * Returns { client, callTool(name, args), close() }.
 */
async function openClient(config) {
  const client = new Client(
    { name: "mcp-load", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = buildTransport(config);
  await client.connect(transport);
  return {
    client,
    callTool: (name, args) =>
      client.callTool({ name, arguments: args || {} }),
    close: async () => {
      try {
        await client.close();
      } catch (_) {
        /* swallow close errors */
      }
    },
  };
}

// -------------------------------------------------------------
// Introspection
// -------------------------------------------------------------

async function listTools(config) {
  return withClient(config, async (client) => {
    const tools = await client.listTools();
    return tools.tools || tools;
  });
}

async function listResources(config) {
  return withClient(config, async (client) => {
    try {
      const r = await client.listResources();
      return r.resources || r;
    } catch (e) {
      return [];
    }
  });
}

async function listPrompts(config) {
  return withClient(config, async (client) => {
    try {
      const p = await client.listPrompts();
      return p.prompts || p;
    } catch (e) {
      return [];
    }
  });
}

// -------------------------------------------------------------
// Direct tool invocation (manual playground)
// -------------------------------------------------------------

async function invokeTool({
  config,
  toolName,
  args,
  saveTrace = true,
  tags = [],
  userId,
  companyId,
}) {
  const started = Date.now();
  let toolResponse = null;
  let toolSchema = null;
  let status = "ok";
  let errorMsg = null;

  try {
    toolResponse = await withClient(config, async (client) => {
      const { tools } = await client.listTools();
      toolSchema = (tools || []).find((t) => t.name === toolName) || null;
      if (!toolSchema)
        throw new Error(`Tool "${toolName}" not found on server`);
      return client.callTool({ name: toolName, arguments: args || {} });
    });
  } catch (err) {
    status = "error";
    errorMsg = err.message || String(err);
  }

  const latencyMs = Date.now() - started;

  let trace = null;
  if (saveTrace) {
    trace = await McpTrace.create({
      serverName: config.name || "unknown",
      serverUrl: publicServerUrl(config.url),
      transport: config.transport || "http",
      toolName,
      toolArgs: args,
      toolSchema,
      toolResponse,
      latencyMs,
      status,
      error: errorMsg,
      provider: "none",
      tags,
      userId,
      companyId,
    });
  }

  return {
    trace,
    toolResponse,
    toolSchema,
    latencyMs,
    status,
    error: errorMsg,
  };
}

// -------------------------------------------------------------
// LLM-driven tool invocation (the LLM chooses the tool)
// -------------------------------------------------------------

/**
 * Convert an MCP tool definition -> OpenAI function spec.
 */
function mcpToolsToOpenAI(tools) {
  return (tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));
}

/**
 * Convert an MCP tool definition -> Anthropic tool spec.
 */
function mcpToolsToAnthropic(tools) {
  return (tools || []).map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema || { type: "object", properties: {} },
  }));
}

/**
 * Let a chosen LLM pick a tool and invoke it against the real MCP server.
 * provider = "openai" | "anthropic"
 */
async function runPromptAgainstMcp({
  config,
  userPrompt,
  provider = "openai",
  model,
  saveTrace = true,
  tags = [],
  userId,
  companyId,
  anthropicClient = null,
}) {
  const started = Date.now();
  return withClient(config, async (client) => {
    const { tools } = await client.listTools();

    let chosen = null;
    let rawResponse = null;

    if (provider === "openai") {
      const chosenModel = model || DEFAULT_OPENAI_MODEL;
      const completion = await getOpenAI().chat.completions.create({
        model: chosenModel,
        messages: [
          {
            role: "system",
            content:
              "You are an MCP test agent. Given the user query, pick the single best tool and call it with well-formed arguments.",
          },
          { role: "user", content: userPrompt },
        ],
        tools: mcpToolsToOpenAI(tools),
        tool_choice: "auto",
      });
      rawResponse = completion;
      const call = completion.choices?.[0]?.message?.tool_calls?.[0];
      if (call) {
        chosen = {
          name: call.function.name,
          args: JSON.parse(call.function.arguments || "{}"),
        };
      }
    } else if (provider === "anthropic") {
      const chosenModel = model || DEFAULT_CLAUDE_MODEL;
      const client = aiUsage.tag(anthropicClient || getAnthropic(), { action: "mcp_lab", surface: "mcp" });
      const msg = await client.messages.create({
        model: chosenModel,
        max_tokens: 1024,
        system:
          "You are an MCP test agent. Given the user query, pick the single best tool and call it with well-formed arguments.",
        messages: [{ role: "user", content: userPrompt }],
        tools: mcpToolsToAnthropic(tools),
      });
      rawResponse = msg;
      const toolUse = (msg.content || []).find((c) => c.type === "tool_use");
      if (toolUse) {
        chosen = { name: toolUse.name, args: toolUse.input || {} };
      }
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }

    let toolResponse = null;
    let status = "ok";
    let errorMsg = null;

    if (!chosen) {
      status = "error";
      errorMsg = "LLM did not select any tool";
    } else {
      try {
        toolResponse = await client.callTool({
          name: chosen.name,
          arguments: chosen.args,
        });
      } catch (err) {
        status = "error";
        errorMsg = err.message || String(err);
      }
    }

    const latencyMs = Date.now() - started;
    const toolSchema = chosen
      ? (tools || []).find((t) => t.name === chosen.name)
      : null;

    let trace = null;
    if (saveTrace) {
      trace = await McpTrace.create({
        serverName: config.name || "unknown",
        serverUrl: publicServerUrl(config.url),
        transport: config.transport || "http",
        userPrompt,
        toolName: chosen?.name || "none",
        toolArgs: chosen?.args || {},
        toolSchema,
        toolResponse,
        rawResponse,
        latencyMs,
        status,
        error: errorMsg,
        provider,
        model:
          model ||
          (provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_CLAUDE_MODEL),
        tags,
        userId,
        companyId,
      });
    }

    return {
      trace,
      chosen,
      toolResponse,
      latencyMs,
      status,
      error: errorMsg,
    };
  });
}

// -------------------------------------------------------------
// LLM-as-Judge
// -------------------------------------------------------------

const JUDGE_SYSTEM = `You are an expert MCP quality auditor.
You will receive: (1) a user prompt, (2) the MCP tool schema that was called,
(3) the arguments used, and (4) the raw tool response.
Score the interaction from 0-10 and return STRICT JSON with this shape:
{
  "score": number,
  "verdict": "pass" | "fail" | "warn",
  "reasoning": string,
  "suggestions": string[]
}
Focus on: correctness, whether the tool choice made sense, whether the response actually satisfies the prompt, schema ambiguity, and hallucination risk.`;

function buildJudgeUserMessage({
  userPrompt,
  toolSchema,
  toolArgs,
  toolResponse,
}) {
  return `USER PROMPT:
${userPrompt || "(direct tool call, no prompt)"}

TOOL SCHEMA:
${JSON.stringify(toolSchema, null, 2)}

ARGS USED:
${JSON.stringify(toolArgs, null, 2)}

TOOL RESPONSE:
${JSON.stringify(toolResponse, null, 2)}`;
}

function safeParseJson(txt) {
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (_) {
    // try to extract JSON block
    const m = txt.match(/\{[\s\S]*\}/);
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

async function judgeTrace({
  traceId,
  provider = "openai",
  model,
  companyId,
  anthropicClient = null,
}) {
  const filter = { _id: traceId };
  if (companyId) filter.companyId = companyId;
  const trace = await McpTrace.findOne(filter);
  if (!trace) throw new Error("Trace not found");

  const userMsg = buildJudgeUserMessage({
    userPrompt: trace.userPrompt,
    toolSchema: trace.toolSchema,
    toolArgs: trace.toolArgs,
    toolResponse: trace.toolResponse,
  });

  let verdict = null;
  let rawText = null;
  const chosenModel =
    model ||
    (provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_CLAUDE_MODEL);

  if (provider === "openai") {
    const completion = await getOpenAI().chat.completions.create({
      model: chosenModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: userMsg },
      ],
    });
    rawText = completion.choices?.[0]?.message?.content;
    verdict = safeParseJson(rawText);
  } else if (provider === "anthropic") {
    const client = aiUsage.tag(anthropicClient || getAnthropic(), { action: "mcp_lab", surface: "mcp" });
    const msg = await client.messages.create({
      model: chosenModel,
      max_tokens: 1024,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: userMsg }],
    });
    rawText = (msg.content || []).map((c) => c.text || "").join("\n");
    verdict = safeParseJson(rawText);
  } else {
    throw new Error(`Unknown judge provider: ${provider}`);
  }

  if (!verdict) {
    verdict = {
      score: 0,
      verdict: "fail",
      reasoning: "Judge returned unparseable output",
      suggestions: [],
    };
  }

  trace.judge = {
    provider,
    model: chosenModel,
    score: verdict.score,
    verdict: verdict.verdict,
    reasoning: verdict.reasoning,
    suggestions: verdict.suggestions || [],
    raw: rawText,
  };
  await trace.save();
  return trace;
}

// -------------------------------------------------------------
// Test case generator (give me a server, get me 10 test prompts)
// -------------------------------------------------------------

const GENERATOR_SYSTEM = `You are a test-case generator for MCP servers.
Given the list of tools (with schemas), produce a JSON array of realistic,
varied test cases that exercise each tool including edge cases.
Return STRICT JSON with shape:
{
  "cases": [
    {
      "name": string,
      "userPrompt": string,
      "expectedTool": string,
      "expectedArgs": object,
      "assertions": string[]
    }
  ]
}
Cover happy paths, ambiguous prompts (confusion between similar tools),
invalid/missing arguments, and adversarial inputs.`;

async function generateTestCases({
  config,
  provider = "openai",
  model,
  count = 10,
  anthropicClient = null,
}) {
  const tools = await listTools(config);
  const userMsg = `Tools:\n${JSON.stringify(tools, null, 2)}\n\nGenerate ${count} test cases.`;

  const chosenModel =
    model ||
    (provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_CLAUDE_MODEL);

  if (provider === "openai") {
    const completion = await getOpenAI().chat.completions.create({
      model: chosenModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: GENERATOR_SYSTEM },
        { role: "user", content: userMsg },
      ],
    });
    return (
      safeParseJson(completion.choices?.[0]?.message?.content) || { cases: [] }
    );
  }
  if (provider === "anthropic") {
    const client = aiUsage.tag(anthropicClient || getAnthropic(), { action: "mcp_lab", surface: "mcp" });
    const msg = await client.messages.create({
      model: chosenModel,
      max_tokens: 2048,
      system: GENERATOR_SYSTEM,
      messages: [{ role: "user", content: userMsg }],
    });
    const text = (msg.content || []).map((c) => c.text || "").join("\n");
    return safeParseJson(text) || { cases: [] };
  }
  throw new Error(`Unknown provider: ${provider}`);
}

// -------------------------------------------------------------
// Compare MCP tool response vs a direct REST API response
// -------------------------------------------------------------

const COMPARE_SYSTEM = `You compare two responses: one from an MCP tool, one from a REST API.
Return STRICT JSON:
{
  "matchScore": 0-10,
  "divergence": string (short explanation of differences),
  "missingInMcp": string[],
  "missingInApi": string[]
}`;

async function compareWithApi({
  traceId,
  apiResponse,
  apiUrl,
  provider = "openai",
  model,
  companyId,
  anthropicClient = null,
}) {
  const filter = { _id: traceId };
  if (companyId) filter.companyId = companyId;
  const trace = await McpTrace.findOne(filter);
  if (!trace) throw new Error("Trace not found");

  const userMsg = `MCP RESPONSE:
${JSON.stringify(trace.toolResponse, null, 2)}

API RESPONSE:
${JSON.stringify(apiResponse, null, 2)}`;

  const chosenModel =
    model ||
    (provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_CLAUDE_MODEL);

  let parsed = null;
  if (provider === "openai") {
    const completion = await getOpenAI().chat.completions.create({
      model: chosenModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: COMPARE_SYSTEM },
        { role: "user", content: userMsg },
      ],
    });
    parsed = safeParseJson(completion.choices?.[0]?.message?.content);
  } else if (provider === "anthropic") {
    const client = aiUsage.tag(anthropicClient || getAnthropic(), { action: "mcp_lab", surface: "mcp" });
    const msg = await client.messages.create({
      model: chosenModel,
      max_tokens: 1024,
      system: COMPARE_SYSTEM,
      messages: [{ role: "user", content: userMsg }],
    });
    parsed = safeParseJson(
      (msg.content || []).map((c) => c.text || "").join("\n"),
    );
  }

  trace.comparison = {
    apiUrl,
    apiResponse,
    divergence: parsed?.divergence || "unparseable",
    matchScore: parsed?.matchScore ?? 0,
  };
  await trace.save();
  return trace;
}

module.exports = {
  listTools,
  listResources,
  listPrompts,
  openClient,
  invokeTool,
  runPromptAgainstMcp,
  judgeTrace,
  generateTestCases,
  compareWithApi,
};
