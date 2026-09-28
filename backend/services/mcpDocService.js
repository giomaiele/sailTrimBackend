const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const aiUsage = require("./aiUsageService.js");

const McpDoc = require("../model/McpDocModel.js");
const mcpLab = require("./mcpLabService.js");
const { publicServerUrl } = require("./mcpProjectService.js");

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
  return aiUsage.meter(_anthropic, { payer: "platform", action: "mcp_docs", surface: "mcp" });
}

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MCP_DOCS_MODEL || "gpt-4o";
const DEFAULT_CLAUDE_MODEL =
  process.env.CLAUDE_MCP_DOCS_MODEL || "claude-sonnet-4-6";

const MCP_DOC_SYSTEM = `You are an MCP documentation generator.
You receive ONE MCP tool definition, sample arguments, execution status, and response schema inferred from an actual MCP tool call. Return STRICT JSON for that single tool:
{
  "doc": {
    "toolName": string,
    "title": string,
    "summary": string,
    "description": string,
    "arguments": [
      {
        "name": string,
        "type": string,
        "required": boolean,
        "description": string,
        "default": any,
        "enum": any[]
      }
    ],
    "responseNotes": string,
    "examples": [
      {
        "title": string,
        "prompt": string,
        "args": object,
        "expectedResult": string
      }
    ],
    "risks": string[]
  }
}

Rules:
- Use only facts available in the tool name, description, and input schema.
- If a field has no description, infer a short practical description from its name and schema.
- Include at least one realistic example for the tool.
- Mark required arguments from the JSON schema's required array.
- Response docs must be based on outputSchema or inferredOutputSchema from an actual tool execution.
- If responseVerified is false, responseNotes MUST be exactly:
  "Response could not be verified from a successful MCP tool execution."
- If responseVerified is false, do not claim exact response shape, fields, item counts, or primitive type.
- Never write unsupported response claims like "returns a string", "returns all fields", or "returns every item" unless outputSchema or inferredOutputSchema proves it.
- Keep language product-ready and concise.`;

const SAMPLE_ARGS_SYSTEM = `You generate realistic sample arguments for a single MCP tool call.
You receive ONE MCP tool's name, description, and inputSchema. Return STRICT JSON:
{
  "args": object
}

Rules:
- The args object MUST satisfy the inputSchema (correct types, all required fields present).
- Use realistic values that would actually exercise the tool successfully — avoid placeholders like "string", "example", or 1 unless the schema constrains the value.
- Prefer concrete realistic values inferred from the field name, description, and tool description.
- For arrays, include at least one realistic item.
- For enums, pick the most representative value.
- Omit non-required fields when they would force you to guess unsafely.`;

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

function humanizeName(name = "") {
  return String(name)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function schemaType(schema = {}) {
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (schema.type) return schema.type;
  if (schema.enum) return "enum";
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "any";
}

function exampleValue(schema = {}) {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "number" || type === "integer") return 1;
  if (type === "boolean") return true;
  if (type === "array") return [exampleValue(schema.items || {})];
  if (type === "object" || schema.properties) {
    return Object.entries(schema.properties || {}).reduce(
      (acc, [key, childSchema]) => {
        acc[key] = exampleValue(childSchema);
        return acc;
      },
      {},
    );
  }
  return "example";
}

function sampleArgsFromSchema(inputSchema = {}) {
  const properties = inputSchema.properties || {};
  const required = new Set(inputSchema.required || []);
  return Object.entries(properties).reduce((acc, [name, schema]) => {
    if (
      required.has(name) ||
      schema.default !== undefined ||
      schema.enum?.length
    ) {
      acc[name] = exampleValue(schema);
    }
    return acc;
  }, {});
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return value;
  }
}

function sampleArraysForDocs(value) {
  if (Array.isArray(value)) {
    return value.length ? [sampleArraysForDocs(value[0])] : [];
  }
  if (value && typeof value === "object") {
    return Object.entries(value).reduce((acc, [key, child]) => {
      acc[key] = sampleArraysForDocs(child);
      return acc;
    }, {});
  }
  return value;
}

function extractToolResponseJson(toolResponse) {
  if (!toolResponse) return null;
  if (toolResponse.structuredContent !== undefined) {
    return parseMaybeJson(toolResponse.structuredContent);
  }

  const content = toolResponse.content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text.trim())
      .filter(Boolean);
    if (textParts.length === 1) return parseMaybeJson(textParts[0]);
    if (textParts.length > 1) return textParts.map(parseMaybeJson);
  }

  return parseMaybeJson(toolResponse);
}

function inferJsonSchema(value) {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length ? inferJsonSchema(value[0]) : {},
    };
  }

  const type = typeof value;
  if (type === "string" || type === "boolean") return { type };
  if (type === "number") {
    return { type: Number.isInteger(value) ? "integer" : "number" };
  }
  if (type === "object") {
    return {
      type: "object",
      properties: Object.entries(value).reduce((acc, [key, child]) => {
        acc[key] = inferJsonSchema(child);
        return acc;
      }, {}),
      required: Object.keys(value),
    };
  }
  return {};
}

async function verifyToolResponse({
  config,
  tool,
  sampleArgsOverride,
  userId,
  companyId,
}) {
  const sampleArgs =
    sampleArgsOverride || sampleArgsFromSchema(tool.inputSchema || {});
  const result = await mcpLab.invokeTool({
    config,
    toolName: tool.name,
    args: sampleArgs,
    saveTrace: false,
    userId,
    companyId,
  });

  if (result.status !== "ok" || result.error) {
    return {
      responseVerified: false,
      responseStatus: "unverified",
      sampleArgs,
      sampleResponse: null,
      // Even on error, trim to a single-object sample — never persist bulk data.
      rawToolResponse:
        sampleArraysForDocs(extractToolResponseJson(result.toolResponse)) ||
        null,
      responseExample: null,
      responseSchema: null,
      inferredOutputSchema: null,
      responseError: result.error || "Tool execution failed",
    };
  }

  const sampleResponse = sampleArraysForDocs(
    extractToolResponseJson(result.toolResponse),
  );
  const inferredOutputSchema = inferJsonSchema(sampleResponse);
  return {
    responseVerified: true,
    responseStatus: "final",
    sampleArgs,
    sampleResponse,
    // Store only the trimmed single-object sample (arrays cut to 1 element),
    // never the full raw payload — so we never persist a customer's bulk data.
    rawToolResponse: sampleResponse,
    responseExample: sampleResponse,
    responseSchema: tool.outputSchema || inferredOutputSchema,
    inferredOutputSchema,
    responseError: null,
  };
}

function argumentsFromSchema(inputSchema = {}) {
  const properties = inputSchema.properties || {};
  const required = new Set(inputSchema.required || []);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    type: schemaType(schema),
    required: required.has(name),
    description: schema.description || `${humanizeName(name)} argument.`,
    default: schema.default,
    enum: schema.enum || [],
  }));
}

function fallbackDocForTool(tool, verification) {
  const args = argumentsFromSchema(tool.inputSchema || {});
  const declaredOutputSchema = tool.outputSchema || null;
  const inferredOutputSchema = verification?.inferredOutputSchema || null;
  const responseVerified = !!verification?.responseVerified;
  const exampleArgs = args.reduce((acc, arg) => {
    if (arg.required)
      acc[arg.name] = exampleValue(
        (tool.inputSchema?.properties || {})[arg.name],
      );
    return acc;
  }, {});

  return {
    toolName: tool.name,
    title: humanizeName(tool.name),
    summary: tool.description || `Calls the ${tool.name} MCP tool.`,
    description:
      tool.description ||
      `Use this tool when the client needs ${humanizeName(tool.name).toLowerCase()}.`,
    inputSchema: tool.inputSchema || { type: "object", properties: {} },
    outputSchema: declaredOutputSchema,
    inferredOutputSchema,
    responseVerified,
    responseStatus: responseVerified ? "final" : "unverified",
    sampleArgs: verification?.sampleArgs || exampleArgs,
    sampleResponse: verification?.sampleResponse || null,
    rawToolResponse: verification?.rawToolResponse || null,
    responseExample:
      verification?.responseExample || verification?.sampleResponse || null,
    responseSchema: declaredOutputSchema || inferredOutputSchema,
    responseError: verification?.responseError || null,
    arguments: args,
    responseNotes:
      responseVerified && declaredOutputSchema
        ? `Response shape is declared by the MCP server as ${schemaType(declaredOutputSchema)}.`
        : responseVerified && inferredOutputSchema
          ? `Response schema inferred from a successful MCP tool execution as ${schemaType(inferredOutputSchema)}.`
          : "Response could not be verified from a successful MCP tool execution.",
    examples: [
      {
        title: `Use ${humanizeName(tool.name)}`,
        prompt: tool.description || `Run ${tool.name}.`,
        args: verification?.sampleArgs || exampleArgs,
        expectedResult:
          responseVerified && declaredOutputSchema
            ? "The server returns a response matching its declared output schema."
            : responseVerified && inferredOutputSchema
              ? "The server returns a response matching the schema inferred from the sample execution."
              : "Response could not be verified from a successful MCP tool execution.",
      },
    ],
    risks: [],
    rawTool: tool,
  };
}

function normalizeDocs({
  tools,
  verifications,
  generatedDocs,
  provider,
  model,
}) {
  const byName = new Map(
    (generatedDocs || []).map((doc) => [doc.toolName, doc]),
  );
  const verificationByName = new Map(
    (verifications || []).map((item) => [item.toolName, item]),
  );
  return (tools || []).map((tool) => {
    const verification = verificationByName.get(tool.name);
    const fallback = fallbackDocForTool(tool, verification);
    const generated = byName.get(tool.name) || {};
    return {
      ...fallback,
      ...generated,
      toolName: tool.name,
      inputSchema: tool.inputSchema || fallback.inputSchema,
      outputSchema: tool.outputSchema || null,
      inferredOutputSchema: verification?.inferredOutputSchema || null,
      responseVerified: !!verification?.responseVerified,
      responseStatus: verification?.responseVerified ? "final" : "unverified",
      sampleArgs: verification?.sampleArgs || fallback.sampleArgs,
      sampleResponse: verification?.sampleResponse || null,
      rawToolResponse: verification?.rawToolResponse || null,
      responseExample:
        verification?.responseExample || verification?.sampleResponse || null,
      responseSchema:
        tool.outputSchema || verification?.inferredOutputSchema || null,
      responseError: verification?.responseError || null,
      arguments: generated.arguments?.length
        ? generated.arguments
        : fallback.arguments,
      examples: generated.examples?.length
        ? generated.examples
        : fallback.examples,
      risks: generated.risks || fallback.risks,
      rawTool: tool,
      generatedBy: { provider, model },
    };
  });
}

function enforceResponseVerificationRule({ docs }) {
  return (docs || []).map((doc) => {
    if (doc.responseVerified) return doc;

    return {
      ...doc,
      responseVerified: false,
      responseStatus: "unverified",
      responseExample: null,
      responseSchema: null,
      responseNotes: "Response shape not declared by the MCP server.",
      examples: (doc.examples || []).map((example) => ({
        ...example,
        expectedResult:
          "Response could not be verified from a successful MCP tool execution.",
      })),
    };
  });
}

async function curateToolDoc({ tool, provider, model, anthropicClient }) {
  const chosenProvider = provider || "openai";
  const chosenModel =
    model ||
    (chosenProvider === "anthropic"
      ? DEFAULT_CLAUDE_MODEL
      : DEFAULT_OPENAI_MODEL);
  const userMsg = `MCP TOOL:\n${JSON.stringify(tool, null, 2)}`;

  if (chosenProvider === "openai") {
    const completion = await getOpenAI().chat.completions.create({
      model: chosenModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: MCP_DOC_SYSTEM },
        { role: "user", content: userMsg },
      ],
    });
    const raw = completion.choices?.[0]?.message?.content;
    return {
      parsed: safeParseJson(raw),
      usage: {
        inputTokens: completion.usage?.prompt_tokens || 0,
        outputTokens: completion.usage?.completion_tokens || 0,
        model: chosenModel,
      },
    };
  }

  if (chosenProvider === "anthropic") {
    const client = aiUsage.tag(anthropicClient || getAnthropic(), { action: "mcp_docs", surface: "mcp" });
    const msg = await client.messages.create({
      model: chosenModel,
      max_tokens: 2048,
      system: MCP_DOC_SYSTEM,
      messages: [{ role: "user", content: userMsg }],
    });
    const raw = (msg.content || []).map((c) => c.text || "").join("\n");
    return {
      parsed: safeParseJson(raw),
      usage: {
        inputTokens: msg.usage?.input_tokens || 0,
        outputTokens: msg.usage?.output_tokens || 0,
        model: chosenModel,
      },
    };
  }

  throw new Error(`Unknown docs provider: ${chosenProvider}`);
}

async function suggestSampleArgs({ tool, provider, model, anthropicClient }) {
  const chosenProvider = provider || "anthropic";
  const chosenModel =
    model ||
    (chosenProvider === "anthropic"
      ? DEFAULT_CLAUDE_MODEL
      : DEFAULT_OPENAI_MODEL);
  const userMsg = `Tool: ${tool.name}
Description: ${tool.description || "(none)"}
inputSchema:
${JSON.stringify(tool.inputSchema || {}, null, 2)}`;

  let parsed = null;
  let usage = { inputTokens: 0, outputTokens: 0, model: chosenModel };

  try {
    if (chosenProvider === "openai") {
      const completion = await getOpenAI().chat.completions.create({
        model: chosenModel,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SAMPLE_ARGS_SYSTEM },
          { role: "user", content: userMsg },
        ],
      });
      parsed = safeParseJson(completion.choices?.[0]?.message?.content);
      usage = {
        inputTokens: completion.usage?.prompt_tokens || 0,
        outputTokens: completion.usage?.completion_tokens || 0,
        model: chosenModel,
      };
    } else if (chosenProvider === "anthropic") {
      const client = aiUsage.tag(anthropicClient || getAnthropic(), { action: "mcp_docs", surface: "mcp" });
      const msg = await client.messages.create({
        model: chosenModel,
        max_tokens: 512,
        system: SAMPLE_ARGS_SYSTEM,
        messages: [{ role: "user", content: userMsg }],
      });
      parsed = safeParseJson(
        (msg.content || []).map((c) => c.text || "").join("\n"),
      );
      usage = {
        inputTokens: msg.usage?.input_tokens || 0,
        outputTokens: msg.usage?.output_tokens || 0,
        model: chosenModel,
      };
    }
  } catch (_) {
    parsed = null;
  }

  const fallback = sampleArgsFromSchema(tool.inputSchema || {});
  const args =
    parsed && parsed.args && typeof parsed.args === "object"
      ? parsed.args
      : fallback;
  return { args, usage };
}

async function saveDocs({
  docs,
  config,
  projectId,
  userId,
  companyId,
  tags = [],
}) {
  if (!docs.length) return 0;

  const serverName = config.name || config.url || "unnamed";
  const safeServerUrl = publicServerUrl(config.url);
  const ops = docs.map((doc) => ({
    updateOne: {
      filter: {
        serverName,
        projectId,
        serverUrl: safeServerUrl,
        transport: config.transport || "http",
        toolName: doc.toolName,
        companyId,
      },
      update: {
        $set: {
          ...doc,
          serverName,
          projectId,
          serverUrl: safeServerUrl,
          transport: config.transport || "http",
          userId,
          companyId,
          tags,
          updatedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  const result = await McpDoc.bulkWrite(ops);
  return (result.upsertedCount || 0) + (result.modifiedCount || 0);
}

async function generateDocs({
  config,
  projectId,
  provider = "anthropic",
  model,
  save = true,
  userId,
  companyId,
  tags = [],
  sampleArgsByTool = {},
  anthropicClient = null,
}) {
  const tools = await mcpLab.listTools(config);

  const argSuggestions = await Promise.all(
    (tools || []).map(async (tool) => {
      if (sampleArgsByTool[tool.name]) {
        return {
          toolName: tool.name,
          args: sampleArgsByTool[tool.name],
          usage: null,
        };
      }
      const out = await suggestSampleArgs({
        tool,
        provider,
        model,
        anthropicClient,
      });
      return { toolName: tool.name, args: out.args, usage: out.usage };
    }),
  );
  const argsByTool = argSuggestions.reduce((acc, item) => {
    acc[item.toolName] = item.args;
    return acc;
  }, {});

  const verifications = await Promise.all(
    (tools || []).map(async (tool) => ({
      toolName: tool.name,
      ...(await verifyToolResponse({
        config,
        tool,
        sampleArgsOverride: argsByTool[tool.name],
        userId,
        companyId,
      }).catch((err) => ({
        responseVerified: false,
        responseStatus: "unverified",
        sampleArgs:
          argsByTool[tool.name] || sampleArgsFromSchema(tool.inputSchema || {}),
        sampleResponse: null,
        rawToolResponse: null,
        responseExample: null,
        responseSchema: null,
        inferredOutputSchema: null,
        responseError: err.message || String(err),
      }))),
    })),
  );

  const toolsWithResponses = tools.map((tool) => {
    const verification = verifications.find(
      (item) => item.toolName === tool.name,
    );
    return {
      ...tool,
      responseVerified: verification?.responseVerified || false,
      responseStatus: verification?.responseStatus || "unverified",
      sampleArgs: verification?.sampleArgs || {},
      sampleResponse: verification?.sampleResponse || null,
      rawToolResponse: verification?.rawToolResponse || null,
      responseExample:
        verification?.responseExample || verification?.sampleResponse || null,
      responseSchema:
        tool.outputSchema || verification?.inferredOutputSchema || null,
      inferredOutputSchema: verification?.inferredOutputSchema || null,
      responseError: verification?.responseError || null,
    };
  });

  let usage = { inputTokens: 0, outputTokens: 0, model: null };
  let generationError = null;
  let generatedBy = { provider: "none", model: null };

  for (const suggestion of argSuggestions) {
    if (suggestion.usage) {
      usage.inputTokens += suggestion.usage.inputTokens || 0;
      usage.outputTokens += suggestion.usage.outputTokens || 0;
      usage.model = suggestion.usage.model || usage.model;
    }
  }

  const perToolResults = await Promise.all(
    toolsWithResponses.map(async (tool) => {
      try {
        const curated = await curateToolDoc({
          tool,
          provider,
          model,
          anthropicClient,
        });
        return {
          toolName: tool.name,
          parsed: curated.parsed,
          usage: curated.usage,
          error: null,
        };
      } catch (err) {
        return {
          toolName: tool.name,
          parsed: null,
          usage: { inputTokens: 0, outputTokens: 0, model: null },
          error: err.message || String(err),
        };
      }
    }),
  );

  const generatedDocs = [];
  for (const result of perToolResults) {
    if (result.usage) {
      usage.inputTokens += result.usage.inputTokens || 0;
      usage.outputTokens += result.usage.outputTokens || 0;
      usage.model = result.usage.model || usage.model;
    }
    const doc = result.parsed?.doc;
    if (doc) generatedDocs.push({ ...doc, toolName: result.toolName });
    if (result.error && !generationError) generationError = result.error;
  }
  if (generatedDocs.length) {
    generatedBy = { provider, model: usage.model };
  }

  const docs = enforceResponseVerificationRule({
    docs: normalizeDocs({
      tools,
      verifications,
      generatedDocs,
      provider: generatedBy.provider,
      model: generatedBy.model,
    }),
  }).map((doc) => ({ ...doc, projectId }));
  const savedCount = save
    ? await saveDocs({ docs, config, projectId, userId, companyId, tags })
    : 0;
  const toolResponses = verifications.reduce((acc, verification) => {
    acc[verification.toolName] = {
      responseVerified: verification.responseVerified,
      responseStatus: verification.responseStatus,
      sampleArgs: verification.sampleArgs,
      response: verification.sampleResponse,
      rawToolResponse: verification.rawToolResponse || null,
      responseSchema:
        verification.responseSchema ||
        verification.inferredOutputSchema ||
        null,
      responseError: verification.responseError || null,
    };
    return acc;
  }, {});

  return {
    docs,
    toolResponses,
    savedCount,
    usage,
    curated: generatedDocs.length > 0,
    generationError,
  };
}

async function generateDocForTool({
  config,
  projectId,
  tool,
  sampleArgs,
  provider = "anthropic",
  model,
  save = true,
  userId,
  companyId,
  tags = [],
  anthropicClient = null,
}) {
  if (!tool) throw new Error("tool is required");

  const verification = await verifyToolResponse({
    config,
    tool,
    sampleArgsOverride: sampleArgs,
    userId,
    companyId,
  }).catch((err) => ({
    responseVerified: false,
    responseStatus: "unverified",
    sampleArgs: sampleArgs || sampleArgsFromSchema(tool.inputSchema || {}),
    sampleResponse: null,
    rawToolResponse: null,
    responseExample: null,
    responseSchema: null,
    inferredOutputSchema: null,
    responseError: err.message || String(err),
  }));

  const toolWithResponse = {
    ...tool,
    responseVerified: verification.responseVerified,
    responseStatus: verification.responseStatus,
    sampleArgs: verification.sampleArgs || {},
    sampleResponse: verification.sampleResponse || null,
    rawToolResponse: verification.rawToolResponse || null,
    responseExample:
      verification.responseExample || verification.sampleResponse || null,
    responseSchema:
      tool.outputSchema || verification.inferredOutputSchema || null,
    inferredOutputSchema: verification.inferredOutputSchema || null,
    responseError: verification.responseError || null,
  };

  let usage = { inputTokens: 0, outputTokens: 0, model: null };
  let generationError = null;
  let generatedDoc = null;
  let generatedBy = { provider: "none", model: null };

  try {
    const curated = await curateToolDoc({
      tool: toolWithResponse,
      provider,
      model,
      anthropicClient,
    });
    usage = curated.usage;
    if (curated.parsed?.doc) {
      generatedDoc = { ...curated.parsed.doc, toolName: tool.name };
      generatedBy = { provider, model: usage.model };
    }
  } catch (err) {
    generationError = err.message || String(err);
  }

  const docs = enforceResponseVerificationRule({
    docs: normalizeDocs({
      tools: [tool],
      verifications: [{ toolName: tool.name, ...verification }],
      generatedDocs: generatedDoc ? [generatedDoc] : [],
      provider: generatedBy.provider,
      model: generatedBy.model,
    }),
  }).map((doc) => ({ ...doc, projectId }));

  const savedCount = save
    ? await saveDocs({ docs, config, projectId, userId, companyId, tags })
    : 0;

  return {
    doc: docs[0],
    savedCount,
    usage,
    verification,
    generationError,
    curated: !!generatedDoc,
  };
}

async function listDocs({
  serverName,
  serverUrl,
  toolName,
  projectId,
  companyId,
  limit = 100,
}) {
  const q = {};
  if (projectId) q.projectId = projectId;
  if (serverName) q.serverName = serverName;
  if (serverUrl) q.serverUrl = serverUrl;
  if (toolName) q.toolName = toolName;
  if (companyId) q.companyId = companyId;
  return McpDoc.find(q).sort({ updatedAt: -1 }).limit(Number(limit));
}

module.exports = {
  generateDocs,
  generateDocForTool,
  listDocs,
  extractToolResponseJson,
  inferJsonSchema,
  sampleArgsFromSchema,
  suggestSampleArgs,
  curateToolDoc,
  verifyToolResponse,
  normalizeDocs,
  enforceResponseVerificationRule,
  saveDocs,
};
