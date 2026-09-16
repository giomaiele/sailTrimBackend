const Doc = require("../model/DocModel");
const ApiProject = require("../model/ApiProject");
const ApiSuite = require("../model/ApiSuiteModel");
const {
  loadDocForCompany,
  resolveDocRunConfig,
  executeTestCase,
  CLAUDE_MODEL,
} = require("./apiQAService");
const Anthropic = require("@anthropic-ai/sdk");

// Persistent test suites per endpoint — the API-side counterpart of the MCP
// smoke/regression suites.
//
// How this differs from the existing bug hunter (findBugs): that one generates
// throwaway cases, runs them once and reports bugs. These suites are SAVED, so
// the same checks run again later and a change in behaviour shows up as a
// regression. Each case carries a `covers` sentence a QA lead can read and edit.

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

const SMOKE_SYSTEM = `You write ONE smoke test for an HTTP endpoint: the single happy path that answers "is this endpoint alive and doing its job?".

Return STRICT JSON only:
{
  "cases": [
    {
      "name": "short descriptive name",
      "covers": "ONE plain sentence a non-technical QA lead can read, describing what this test verifies",
      "category": "happy_path",
      "method": "GET",
      "path": "/the/path",
      "headers": {},
      "body": null,
      "expectedStatus": [200],
      "assertions": ["plain-English checks on the response"]
    }
  ]
}

Rules:
- EXACTLY one case. It must be the realistic success scenario.
- Use "{{key}}" placeholders for any path param or field matching an available environment variable; the runner substitutes real values.
- "body" is null for GET/DELETE.
- assertions are concrete and checkable from the response alone (e.g. "returns a list of users", "each item has an id"). 2 to 4 of them.
- Return only the JSON object.`;

const REGRESSION_SYSTEM = `You write a REGRESSION suite for an HTTP endpoint: the set of checks that must keep behaving the same over time. Re-run later, any deviation is a regression.

Return STRICT JSON only:
{
  "cases": [
    {
      "name": "short descriptive name",
      "covers": "ONE plain sentence a non-technical QA lead can read, describing what this test verifies",
      "category": "happy_path | not_found | unauthorized | invalid_input | boundary | security",
      "method": "GET",
      "path": "/the/path",
      "headers": {},
      "body": null,
      "expectedStatus": [200],
      "assertions": ["plain-English checks on the response"]
    }
  ]
}

Rules:
- Between 4 and 8 cases. Always include the happy path. Then cover the contract that must not silently change: not found, unauthorized, invalid input, and a boundary if the endpoint has one.
- For the unauthorized case set "headers": {"Authorization": ""} so the runner strips auth.
- Use "{{key}}" placeholders for path params matching an available environment variable. For not_found cases use an obviously-bogus literal id instead.
- "body" is null for GET/DELETE.
- Every case needs a "covers" sentence and 1 to 4 assertions.
- Return only the JSON object.`;

// GitHub-imported endpoints all land with section "default", so the tests page
// would show one meaningless bucket. Derive a section from the path instead:
// /api/checkout/pay -> "checkout", /users/{id} -> "users". A doc that already
// carries a real section (spec imports do) keeps it.
function sectionForDoc(doc) {
  const existing = (doc.section || "").trim();
  if (existing && existing !== "default") return existing;
  const segments = String(doc.path || "")
    .split("/")
    .filter(Boolean)
    // drop version and mount prefixes, and anything that's a parameter
    .filter((seg) => !/^(api|v\d+)$/i.test(seg))
    .filter((seg) => !seg.startsWith(":") && !seg.startsWith("{"));
  return segments[0] || "default";
}

// The half of a suite that identifies which API the endpoint belongs to.
function ownerFieldsFor(doc) {
  return doc.projectId
    ? { projectId: doc.projectId, owner: "", repo: "" }
    : { projectId: null, owner: doc.owner || "", repo: doc.repo || "" };
}

function specForPrompt(doc) {
  return {
    method: doc.method,
    path: doc.path,
    description: doc.description,
    requestBody: doc.requestBody,
    queryParams: doc.queryParams,
    responses: doc.responses,
  };
}

/**
 * Generate (or regenerate) the smoke or regression suite for ONE endpoint.
 * Replaces any existing suite of that kind — the unique index on
 * (docId, kind) means regenerating never piles up duplicates.
 */
async function generateSuite({
  docId,
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
  const doc = await loadDocForCompany(docId, companyId);

  // Variable names only — the runner substitutes the values, and secrets must
  // never reach the model.
  let varKeys = [];
  if (doc.projectId) {
    const project = await ApiProject.findOne({ _id: doc.projectId, companyId });
    varKeys = (project?.variables || []).map((v) => v.key);
  }
  const envNote = varKeys.length
    ? `\n\nAVAILABLE ENVIRONMENT VARIABLES: ${varKeys.join(", ")}`
    : "";

  const client = anthropicClient || getAnthropic();
  const resp = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    system: kind === "smoke" ? SMOKE_SYSTEM : REGRESSION_SYSTEM,
    messages: [
      {
        role: "user",
        content: `ENDPOINT SPEC:\n${JSON.stringify(specForPrompt(doc), null, 2)}${envNote}`,
      },
    ],
  });

  const parsed = safeParseJson(extractText(resp));
  const raw = Array.isArray(parsed?.cases) ? parsed.cases : [];
  if (!raw.length) {
    const err = new Error(
      "The generator returned no test cases for this endpoint. Try again."
    );
    err.statusCode = 502;
    throw err;
  }

  const cases = raw.map((c) => ({
    name: c.name || `${doc.method} ${doc.path}`,
    covers: c.covers || "",
    category: c.category || "happy_path",
    method: c.method || "",
    path: c.path || "",
    headers: c.headers || null,
    body: c.body ?? null,
    expectedStatus: Array.isArray(c.expectedStatus) ? c.expectedStatus : [],
    assertions: Array.isArray(c.assertions) ? c.assertions : [],
  }));

  const suite = await ApiSuite.findOneAndUpdate(
    { docId: doc._id, kind },
    {
      $set: {
        ...ownerFieldsFor(doc),
        docId: doc._id,
        section: sectionForDoc(doc),
        method: doc.method,
        path: doc.path,
        kind,
        cases,
        generatedBy: { provider: "anthropic", model: CLAUDE_MODEL },
        userId,
        companyId,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return suite;
}

/**
 * Generate both kinds for every endpoint in a section. Sequential on purpose:
 * each endpoint is a Claude call, and firing a whole section in parallel is how
 * you get rate-limited. Partial failures are reported, not thrown — one bad
 * endpoint shouldn't lose the rest of the section's work.
 */
async function generateSectionSuites({
  projectId,
  owner,
  repo,
  section,
  kinds = ["smoke", "regression"],
  userId,
  companyId,
  anthropicClient = null,
}) {
  const scope = projectId
    ? { projectId, companyId }
    : { owner, repo, companyId };
  // Filter on the DERIVED section, not the stored one — that's what the tests
  // page groups by, so "regenerate this section" must mean the same thing.
  const all = await Doc.find(scope);
  const docs =
    section && section !== "all"
      ? all.filter((d) => sectionForDoc(d) === section)
      : all;

  const created = [];
  const failed = [];
  for (const doc of docs) {
    for (const kind of kinds) {
      try {
        const suite = await generateSuite({
          docId: doc._id,
          kind,
          userId,
          companyId,
          anthropicClient,
        });
        created.push({ docId: String(doc._id), kind, cases: suite.cases.length });
      } catch (err) {
        console.error(
          `[api-suite] generate failed ${doc.method} ${doc.path} (${kind}):`,
          err.message
        );
        failed.push({
          docId: String(doc._id),
          endpoint: `${doc.method} ${doc.path}`,
          kind,
          error: err.message,
        });
      }
    }
  }
  return { created, failed, endpoints: docs.length };
}

// ---------- Running a suite ----------

// Shallow key list of a JSON body — enough to notice "the response lost a
// field" without storing the whole payload as a baseline.
function bodyKeysOf(body) {
  if (Array.isArray(body)) {
    const first = body.find((x) => x && typeof x === "object");
    return first ? Object.keys(first).sort() : [];
  }
  if (body && typeof body === "object") return Object.keys(body).sort();
  return [];
}

const JUDGE_SYSTEM = `You check whether an HTTP response satisfies plain-English assertions.

You receive the endpoint spec, the request that was sent, the response received, and a list of assertions.

Return STRICT JSON only:
{
  "results": [
    { "assertion": "copied verbatim from the input", "passed": true, "reason": "one short sentence" }
  ]
}

Rules:
- One entry per assertion, in the same order, with the assertion text copied verbatim.
- Judge ONLY what the response actually shows. If the response cannot confirm the assertion, it did not pass.
- "reason" is one short sentence, concrete, quoting the evidence when useful.
- Return only the JSON object.`;

// Assertions are prose, so a model grades them. Deterministic checks (status
// code, baseline drift) are done in code below and never handed to the model —
// those must not be subject to its judgement.
async function judgeAssertions({ doc, execution, assertions, client }) {
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
            endpoint: `${doc.method} ${doc.path}`,
            request: execution.request,
            response: {
              status: execution.response.status,
              body: truncate(execution.response.body),
              error: execution.response.error,
            },
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
  // Never let a malformed judge reply silently pass a case.
  return assertions.map((a, i) => {
    const r = results[i] || {};
    return {
      assertion: a,
      passed: r.passed === true,
      reason: r.reason || (results[i] ? "" : "The judge returned no verdict."),
    };
  });
}

function truncate(body, max = 4000) {
  if (body == null) return null;
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return s.length > max ? s.slice(0, max) + `… [truncated ${s.length - max} chars]` : s;
}

/**
 * Run every case in a suite against the live API.
 *
 * A case FAILS when the status is outside expectedStatus, the request errored,
 * or an assertion didn't hold. It is additionally a REGRESSION when a baseline
 * exists and the status or the response's top-level keys moved away from it —
 * that's the difference between "this test is red" and "this used to work".
 */
async function runSuite({
  suiteId,
  companyId,
  anthropicClient = null,
  authSchemeName = "",
}) {
  const suite = await ApiSuite.findOne({ _id: suiteId, companyId });
  if (!suite) {
    const err = new Error("Suite not found");
    err.statusCode = 404;
    throw err;
  }
  const doc = await loadDocForCompany(suite.docId, companyId);
  const { config, variables } = await resolveDocRunConfig(doc, companyId, {
    authSchemeName,
  });
  const client = anthropicClient || getAnthropic();

  const results = [];
  for (const c of suite.cases) {
    const execution = await executeTestCase({
      testCase: {
        method: c.method,
        path: c.path,
        headers: c.headers,
        body: c.body,
        // executeTestCase uses this to strip the project's real auth header on
        // an unauthorized case, whatever that header is called.
        category: c.category,
      },
      doc,
      config,
      variables,
    });

    const status = execution.response.status;
    const expected = c.expectedStatus || [];
    const statusOk = expected.length ? expected.includes(status) : status >= 200 && status < 300;

    const assertionResults = await judgeAssertions({
      doc,
      execution,
      assertions: c.assertions || [],
      client,
    });
    const assertionsOk = assertionResults.every((r) => r.passed);

    // Regression = drift from a recorded baseline, which only exists after a
    // first green run. A case that never passed can be failing, never regressed.
    const keys = bodyKeysOf(execution.response.body);
    const base = c.baseline || {};
    const hasBaseline = Boolean(base.recordedAt);
    const missingKeys = hasBaseline
      ? (base.bodyKeys || []).filter((k) => !keys.includes(k))
      : [];
    const statusDrift = hasBaseline && base.status != null && base.status !== status;
    const isRegression = hasBaseline && (statusDrift || missingKeys.length > 0);

    const passed = statusOk && assertionsOk && !execution.response.error;

    // Record the baseline from the first green run so later runs have something
    // to compare against.
    if (passed && !hasBaseline) {
      c.baseline = { status, bodyKeys: keys, recordedAt: new Date() };
    }

    results.push({
      caseId: String(c._id),
      name: c.name,
      covers: c.covers,
      category: c.category,
      passed,
      isRegression,
      status,
      expectedStatus: expected,
      durationMs: execution.response.durationMs,
      error: execution.response.error,
      assertions: assertionResults,
      regressionDetail: isRegression
        ? [
            statusDrift ? `status was ${base.status}, now ${status}` : "",
            missingKeys.length ? `response no longer has: ${missingKeys.join(", ")}` : "",
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

// ---------- Editing what a test covers ----------

const REFINE_SYSTEM = `You are editing ONE API test case based on a user instruction.

You receive the endpoint spec, the current case, and a natural-language instruction describing how to change what it covers.

Your job is ADDITIVE by default: the user is usually asking to ALSO check something, not to throw away what the case already verifies. NEVER drop an existing assertion unless the instruction EXPLICITLY says to remove, replace, or stop checking it.

Return STRICT JSON only:
{
  "name": "updated descriptive name",
  "covers": "updated ONE-sentence description of what this test verifies, in plain language",
  "method": "GET",
  "path": "/the/path",
  "headers": {},
  "body": null,
  "expectedStatus": [200],
  "assertionsToAdd": ["brand-new checks to append (may be empty)"],
  "assertionsToRemove": ["ONLY checks the user explicitly asked to remove, copied VERBATIM from the current assertions (usually empty)"]
}

Rules:
- Keep the case pointed at the same endpoint unless the instruction says otherwise.
- Entries in "assertionsToRemove" MUST match an existing assertion verbatim so it can be removed reliably.
- "covers" must reflect the case AFTER the change, including what was already there.
- Keep "{{key}}" placeholders intact.
- Return only the JSON object.`;

const CREATE_SYSTEM = `You write ONE test case for an HTTP endpoint, from a plain-language instruction.

Return STRICT JSON only:
{
  "name": "short descriptive name",
  "covers": "ONE plain sentence a non-technical QA lead can read, describing what this test verifies",
  "category": "happy_path | not_found | unauthorized | invalid_input | boundary | security",
  "method": "GET",
  "path": "/the/path",
  "headers": {},
  "body": null,
  "expectedStatus": [200],
  "assertions": ["plain-English checks on the response"]
}

Rules:
- Exactly one case, doing what the instruction asks — nothing more.
- Use "{{key}}" placeholders for path params matching an available environment variable.
- For an unauthorized case set "headers": {"Authorization": ""} so the runner strips auth.
- "body" is null for GET/DELETE.
- 1 to 4 assertions, each decidable from the response alone.
- Return only the JSON object.`;

/**
 * Add ONE case to an existing suite: blank (the user fills it in) or written
 * from a sentence. The generators only ever produce a whole suite, so without
 * this a user who wants one more check has to regenerate everything.
 */
async function createCase({
  suiteId,
  companyId,
  instruction = "",
  anthropicClient = null,
}) {
  const suite = await ApiSuite.findOne({ _id: suiteId, companyId });
  if (!suite) {
    const err = new Error("Suite not found");
    err.statusCode = 404;
    throw err;
  }
  const doc = await loadDocForCompany(suite.docId, companyId);

  let next = {
    name: "New test",
    covers: "",
    category: "happy_path",
    method: doc.method || "",
    path: doc.path || "",
    headers: null,
    body: null,
    expectedStatus: [200],
    assertions: [],
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
            { endpoint: specForPrompt(doc), instruction: instruction.trim() },
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
      method: parsed.method || "",
      path: parsed.path || "",
      headers: parsed.headers || null,
      body: parsed.body ?? null,
      expectedStatus: Array.isArray(parsed.expectedStatus)
        ? parsed.expectedStatus
        : [200],
      assertions: Array.isArray(parsed.assertions) ? parsed.assertions : [],
    };
  }

  suite.cases.push(next);
  await suite.save();
  return { suite, case: suite.cases[suite.cases.length - 1] };
}

/**
 * Delete ONE case from a suite. A test written by hand or refined into
 * something wrong has to be removable without dropping the whole suite.
 */
async function deleteCase({ suiteId, caseId, companyId }) {
  const suite = await ApiSuite.findOne({ _id: suiteId, companyId });
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

/**
 * Change what one case covers, from a plain instruction ("also check that it
 * rejects a duplicate email"). Mirrors the MCP refiners so both sides of the
 * product feel the same.
 */
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
  const suite = await ApiSuite.findOne({ _id: suiteId, companyId });
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
  const doc = await loadDocForCompany(suite.docId, companyId);

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
            endpoint: specForPrompt(doc),
            currentCase: {
              name: c.name,
              covers: c.covers,
              method: c.method,
              path: c.path,
              headers: c.headers,
              body: c.body,
              expectedStatus: c.expectedStatus,
              assertions: c.assertions,
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
  if (delta.method !== undefined) c.method = delta.method || "";
  if (delta.path !== undefined) c.path = delta.path || "";
  if (delta.headers !== undefined) c.headers = delta.headers;
  if (delta.body !== undefined) c.body = delta.body;
  if (Array.isArray(delta.expectedStatus)) c.expectedStatus = delta.expectedStatus;
  c.assertions = [...kept, ...added];

  // What the test checks just changed, so the old baseline describes a
  // different test. Drop it rather than report a bogus regression next run.
  c.baseline = { status: null, bodyKeys: [], recordedAt: null };

  await suite.save();
  return { suite, case: suite.cases.id(caseId), added, removed: [...toRemove] };
}

// ---------- Reading ----------

// Every suite of a project, for the tests page. Grouped section → endpoint by
// the caller; this just returns them ordered so that grouping is stable.
async function listProjectSuites({ projectId, owner, repo, companyId }) {
  const scope = projectId
    ? { projectId, companyId }
    : { owner, repo, companyId };
  const suites = await ApiSuite.find(scope)
    .sort({ section: 1, path: 1, kind: 1 })
    .lean();

  // Attach what the endpoint answers with. Writing a check like "the id matches
  // the one I asked for" means knowing the field is called `id` — so the tests
  // page shows the documented response next to the tests instead of making the
  // user open the docs in another tab.
  const Doc = require("../model/DocModel");
  const docs = await Doc.find({ _id: { $in: suites.map((s) => s.docId) } })
    .select("responses")
    .lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return suites.map((s) => ({
    ...s,
    responses: byId.get(String(s.docId))?.responses || [],
  }));
}

module.exports = {
  sectionForDoc,
  generateSuite,
  createCase,
  deleteCase,
  generateSectionSuites,
  runSuite,
  refineCase,
  listProjectSuites,
};
