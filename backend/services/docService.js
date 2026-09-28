const Anthropic = require("@anthropic-ai/sdk");
const aiUsage = require("./aiUsageService.js");
const Doc = require("../model/DocModel");

// Lazy init so a missing key doesn't crash module load.
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || "missing",
    });
  }
  // Metered: every call through the platform key is priced and recorded, so
  // no service can spend Olivia's money invisibly (see aiUsageService).
  return aiUsage.meter(_anthropic, { payer: "platform", action: "api_docs", surface: "api" });
}

// Claude Opus 4.7 — Anthropic's most capable model. Use claude-sonnet-4-6
// for faster/cheaper runs if backfills get expensive.
const CLAUDE_MODEL = process.env.CLAUDE_DOCS_MODEL || "claude-opus-4-7";

// ---------- Prompt building ----------

const DOC_SYSTEM_PROMPT = `You are an API documentation generator that works across ANY backend framework or language (Node/Express, Python/FastAPI/Flask/Django, Ruby/Rails/Sinatra, Go/Gin/Echo/Mux, Java/Spring, C#/.NET, PHP/Laravel/Symfony, Rust/Actix/Axum, Elixir/Phoenix, etc.).

You will be given:
  (A) Optional entry/config files showing how sub-routers are mounted or prefixed. Examples by framework:
      - Express: app.use("/api/user", userRoutes)
      - FastAPI: app.include_router(user_router, prefix="/api/user")
      - Flask: app.register_blueprint(bp, url_prefix="/api/user")
      - Django: path("api/user/", include("users.urls"))
      - Rails: namespace :api do; resources :users; end
      - Laravel: Route::prefix("api")->group(...)
      - Spring: @RequestMapping("/api/user") on the controller class
      - Gin: r.Group("/api/user")
  (B) A single source file that may define HTTP endpoints.

Your job: detect every HTTP endpoint in (B) and output its FULL URL, resolving any prefix from (A) or from class/group decorators inside (B) itself.

Return STRICT JSON only, starting with {, matching this exact shape:
{
  "endpoints": [
    {
      "method": "POST",
      "path": "/api/example/login",
      "description": "What this endpoint does (be specific, infer from handler logic if present)",
      "requestBody": [
        { "name": "fieldName", "type": "String", "required": true, "description": "what it is" }
      ],
      "queryParams": [
        { "name": "paramName", "type": "String", "required": false, "description": "what it is" }
      ],
      "responses": [
        { "status": 200, "description": "Success", "example": { "key": "value" } },
        { "status": 400, "description": "Error", "example": { "message": "error" } }
      ]
    }
  ]
}

Rules:
- If the file defines no endpoints, return {"endpoints": []}.
- ALWAYS resolve the mount/prefix. Combine ALL prefixes that apply (entry-file mount + class/group/blueprint prefix + route path). Example: entry has app.include_router(router, prefix="/api/v1") and the file has @router.post("/users/{id}"), the path is "/api/v1/users/{id}".
- Detect endpoints from any of these signals: HTTP-verb decorators/annotations (@app.get, @GetMapping, [HttpGet], #[get(...)]), router method calls (router.post(...), app.GET(...), Route::post(...)), Django/Flask URL patterns (path(), url(), re_path()), Rails resources/get/post DSL, Phoenix 'get "/path"', etc.
- Use uppercase HTTP methods ("GET", "POST", ...). For "resources :users" / "Route::resource" / similar, expand to the standard CRUD set (GET/POST/PUT/DELETE).
- Do NOT document middleware, error handlers, or non-HTTP handlers.
- Infer requestBody/queryParams from the handler signature when possible (Pydantic models, Rails strong params, Spring @RequestBody, Express req.body destructuring, etc.).
- queryParams are as important as requestBody, and they are the ones most often missed. Read the handler BODY, not just its signature: every filter, search, sort and pagination value the code pulls off the query string is a queryParam. Look for Express \`req.query\` (including destructuring like \`const { page, status } = req.query\`), FastAPI/Flask \`Query(...)\` and \`request.args\`, Rails \`params[:x]\` on GET routes, Spring \`@RequestParam\`, Go \`r.URL.Query().Get(...)\`, Laravel \`$request->query(...)\`. Mark them required=false unless the handler errors when they are absent. Do NOT list path params (\`{id}\`, \`:id\`) here — those belong in the path.
- When the handler signature references a type (e.g. \`pet: PetCreate\`, \`@Body() dto: CreateUserDto\`, \`User user\`), look up that type in the SCHEMA / MODEL FILES section and EXPAND every field of that type into requestBody. Include nested objects and arrays — for arrays, document the element type as a nested object, NEVER leave an empty array. Walk transitive types (if PetCreate has \`owner: OwnerRef\`, expand OwnerRef too).
- Response examples must reflect the response model: include EVERY field the schema declares, with realistic example values (not just \`{}\`). For list responses, include at least one fully populated element.
- If a field in the schema has a default, mark required=false. If it is Optional/Nullable, mark required=false. Otherwise required=true.`;

function buildMountContextBlock(mountContext) {
  if (!mountContext || mountContext.length === 0) return "(no entry files provided)";
  return mountContext
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");
}

function buildSchemaContextBlock(schemaContext) {
  if (!schemaContext || schemaContext.length === 0) return "(no schema files provided)";
  return schemaContext
    .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");
}

function buildUserMessage({ filePath, content, mountContext, schemaContext, knownPrefix, diff }) {
  const mountBlock = buildMountContextBlock(mountContext);
  const schemaBlock = buildSchemaContextBlock(schemaContext);
  let header = `ENTRY FILES (for mount prefix resolution):\n${mountBlock}\n\nSCHEMA / MODEL FILES (use these to fully populate request bodies, query params, and response shapes — every field, every nested object):\n${schemaBlock}`;
  // knownPrefix comes from parsing the entry file's AST directly (not a
  // guess) — when we have it, it overrides whatever the LLM would infer
  // from the mount-context text.
  if (knownPrefix !== undefined && knownPrefix !== null) {
    header += `\n\nVERIFIED MOUNT PREFIX for this file: "${knownPrefix}"\nThis was resolved by parsing the entry file's code directly, not inferred — it is a fact, not a guess. Every endpoint path you output for this file MUST start with this exact prefix (concatenated with the route's own path). Do not recompute or second-guess it from the ENTRY FILES text above.`;
  }
  if (diff) {
    return `${header}\n\nDIFF:\n${diff}`;
  }
  return `${header}\n\nFILE: ${filePath}\n\`\`\`\n${content}\n\`\`\``;
}

function safeParseJson(txt) {
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (_) {
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

// ---------- Core Claude call ----------

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callClaudeWithRetry(client, params) {
  let attempt = 0;
  let lastErr;
  while (attempt <= MAX_RETRIES) {
    try {
      // Streamed, not a plain .create() call: at MAX_OUTPUT_TOKENS (near the
      // model's real ceiling), a response that actually needs most of that
      // budget can run for minutes — a non-streaming HTTP call risks a
      // client-side timeout killing the whole request with nothing to show
      // for it. Streaming removes that failure mode; .finalMessage() still
      // gives back the same accumulated Message this caller expects.
      const stream = client.messages.stream(params);
      return await stream.finalMessage();
    } catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      const isRetryable = RETRYABLE_STATUS.has(status);
      if (!isRetryable || attempt === MAX_RETRIES) throw err;
      const retryAfterHeader = err?.headers?.["retry-after"];
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      const backoff = retryAfterMs && !Number.isNaN(retryAfterMs)
        ? retryAfterMs
        : Math.min(30_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 500);
      console.warn(`Claude retry ${attempt + 1}/${MAX_RETRIES} after ${backoff}ms (status=${status})`);
      await sleep(backoff);
      attempt += 1;
    }
  }
  throw lastErr;
}

// 4096 was too low: a file with 15+ endpoints (full requestBody/response
// schemas expanded per endpoint, per the system prompt) can legitimately
// need more output than that. When the response got cut off mid-JSON, it
// silently parsed to {endpoints: []} — a file with real endpoints reported
// as if it had none, with no error anywhere. Confirmed on this repo:
// mcpLabRoutes.js (42 endpoints) and apiQARoutes.js (21 endpoints) both hit
// exactly 4096 output tokens and lost 100% of their endpoints silently.
//
// Set to the model's actual output ceiling, not a conservative guess: Claude
// only bills for tokens it actually generates, not this ceiling, so there's
// no cost reason to under-set it — and Olivia scans arbitrary customer repos,
// where some file will eventually be denser than anything in this repo. The
// only real risk at a high ceiling is a non-streaming HTTP call timing out
// on a genuinely long generation; callClaudeWithRetry uses
// client.messages.stream(...).finalMessage() specifically to remove that
// risk, so raising this number doesn't trade one failure mode for another.
const MAX_OUTPUT_TOKENS = 128_000;

async function callClaudeForDocs({ filePath, content, mountContext, schemaContext, knownPrefix, diff, anthropicClient = null }) {
  const userMsg = buildUserMessage({ filePath, content, mountContext, schemaContext, knownPrefix, diff });

  const client = aiUsage.tag(anthropicClient || getAnthropic(), { action: "api_docs", surface: "api" });
  const response = await callClaudeWithRetry(client, {
    model: CLAUDE_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: DOC_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });

  const usage = {
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
    model: CLAUDE_MODEL,
  };

  // A response cut off by the token cap is a real failure, not "this file
  // has no endpoints" — surface it loudly (caller's try/catch logs it and
  // counts the file as failed) instead of silently returning an empty
  // array, which is indistinguishable from a genuinely endpoint-less file.
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `Claude response truncated at ${MAX_OUTPUT_TOKENS} output tokens for ${filePath || "diff"} — increase MAX_OUTPUT_TOKENS or split the file`
    );
  }

  const raw = (response.content || []).map((c) => c.text || "").join("");
  const parsed = safeParseJson(raw);
  if (parsed === null) {
    throw new Error(`Claude response was not valid JSON for ${filePath || "diff"}`);
  }
  const endpoints = parsed.endpoints || [];

  return { endpoints, usage };
}

// ---------- Public API ----------

/**
 * PR-mode: called from webhook when a PR is opened/updated.
 * mountContext is optional — webhook flow currently doesn't scan the repo.
 */
async function generateAndSaveDocs(diff, prNumber, repo, owner, userId, mountContext = [], { anthropicClient = null } = {}) {
  const { endpoints, usage } = await callClaudeForDocs({ diff, mountContext, anthropicClient });
  if (endpoints.length === 0) return { endpoints: [], usage };

  const ops = endpoints.map((ep) => ({
    updateOne: {
      filter: { method: ep.method, path: ep.path, repo, owner },
      update: {
        $set: {
          ...ep,
          prNumber,
          repo,
          owner,
          userId,
          source: "pr",
          updatedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  await Doc.bulkWrite(ops);
  return { endpoints, usage };
}

/**
 * Backfill-mode: called per source file.
 * Returns { endpoints, usage } so the caller can aggregate token counts.
 */
async function generateDocsFromFile({ filePath, content, mountContext, schemaContext, knownPrefix, anthropicClient = null }) {
  return callClaudeForDocs({ filePath, content, mountContext, schemaContext, knownPrefix, anthropicClient });
}

async function saveBackfillDocs({
  endpoints,
  repo,
  owner,
  userId,
  companyId,
  sourceFile,
  sourceSha,
  mounted = true,
}) {
  if (!endpoints.length) return 0;

  const ops = endpoints.map((ep) => ({
    updateOne: {
      filter: { method: ep.method, path: ep.path, repo, owner },
      update: {
        $set: {
          ...ep,
          repo,
          owner,
          userId,
          companyId,
          source: "backfill",
          sourceFile,
          sourceSha,
          mounted,
          updatedAt: new Date(),
        },
      },
      upsert: true,
    },
  }));

  await Doc.bulkWrite(ops);
  return endpoints.length;
}

/**
 * Removes backfill docs for this repo whose sourceSha is no longer in
 * the latest scan — i.e. endpoints that no longer exist in the code.
 */
async function cleanupZombieDocs({ owner, repo, liveShas }) {
  if (!liveShas || liveShas.length === 0) return 0;
  const result = await Doc.deleteMany({
    owner,
    repo,
    source: "backfill",
    sourceSha: { $nin: liveShas },
  });
  return result.deletedCount || 0;
}

module.exports = {
  generateAndSaveDocs,
  generateDocsFromFile,
  saveBackfillDocs,
  cleanupZombieDocs,
  CLAUDE_MODEL,
};
