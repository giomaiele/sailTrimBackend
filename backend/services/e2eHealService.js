const Anthropic = require("@anthropic-ai/sdk");
const aiUsage = require("./aiUsageService.js");
const { buildRepoContext } = require("./repoContextService");
const { runSpec } = require("./e2ePlaywrightRunner");
const { decrypt } = require("./secretCrypto");

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || "missing",
    });
  }
  // Metered: every call through the platform key is priced and recorded, so
  // no service can spend Olivia's money invisibly (see aiUsageService).
  return aiUsage.meter(_anthropic, { payer: "platform", action: "e2e_heal", surface: "e2e" });
}

// Opus 4.8 is the current, most capable model — best for the senior-level
// rewrite + multi-step self-heal reasoning. Overridable via env.
const HEAL_MODEL = process.env.E2E_HEAL_MODEL || "claude-opus-4-8";
const MAX_ATTEMPTS = parseInt(process.env.E2E_HEAL_MAX_ATTEMPTS || "4", 10);

// Set E2E_HEAL_DEBUG=1 to print EVERYTHING sent to / received from Claude in the
// backend terminal (system prompt, repo context, the task message, each heal
// turn, and token/cache usage). Off by default so prod logs stay clean.
// NOTE: this prints the raw prompt — which today can include decrypted secrets
// until the redaction fix lands, so only enable it on a dev machine.
const DEBUG = !!process.env.E2E_HEAL_DEBUG;
function dbg(...args) {
  if (DEBUG) console.log("[e2e-heal]", ...args);
}
function dbgBlock(label, text) {
  if (!DEBUG) return;
  console.log(`\n[e2e-heal] ===== ${label} =====\n${text}\n[e2e-heal] ===== /${label} =====\n`);
}

const SENIOR_SYSTEM_PROMPT = `You are a STAFF-level QA automation engineer. You are given a Playwright test that was AUTO-RECORDED from a real user's UI session (raw codegen output), plus the intended behavior as Gherkin, plus a read-only snapshot of the front-end repo. Rewrite the test to production quality and make it PASS.

How a senior engineer does this:
- REUSE (DRY): if the repo already has helpers, fixtures, or page objects that do what a step needs, IMPORT and use them instead of duplicating logic. Match the import paths and conventions of the existing e2e tests in the context.
- SELECTORS: prefer page.getByTestId(...) / getByRole(...) using data-testids that EXIST in the repo context. Replace the brittle CSS/XPath/nth-child selectors the recorder emitted. NEVER invent a data-testid that is not in the provided selector index or an existing test.
- ASSERTIONS: turn the recorded clicks/gotos into web-first assertions (expect(locator).toBeVisible(), toHaveText, toHaveURL, …) that verify the Gherkin "then" steps. A recording with no assertions is not a test.
- DETERMINISM: no page.waitForTimeout / arbitrary sleeps; rely on Playwright auto-waiting locators. No conditional flakiness.
- AUTH: do NOT add login steps — the run is already authenticated via a stored session.
- Keep it a single self-contained spec file unless a repo helper is the right reuse.

Output ONLY the final spec inside a single \`\`\`typescript code block. No prose, no explanation.`;

function extractText(resp) {
  return (resp.content || [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
}

function extractCode(text) {
  const m = text.match(/```(?:typescript|ts|tsx|javascript|js)?\s*\n([\s\S]*?)```/i);
  return m ? m[1].trim() : "";
}

// `text` is the user's raw scenario when present — pass it through untouched so
// Claude sees the real step order (interleaved When/Then, And/But), which
// rebuilding from the three arrays would flatten.
function renderGherkin(g = {}, text = "") {
  if (text && text.trim()) return text.trim();
  const lines = [];
  if (g.feature) lines.push(`Feature: ${g.feature}`);
  if (g.scenario) lines.push(`Scenario: ${g.scenario}`);
  (g.given || []).forEach((s) => lines.push(`  Given ${s}`));
  (g.when || []).forEach((s) => lines.push(`  When ${s}`));
  (g.then || []).forEach((s) => lines.push(`  Then ${s}`));
  return lines.join("\n") || "(no Gherkin provided)";
}

// Decrypt secrets so the generated test can use real data (runs locally only).
function renderVariables(variables = []) {
  if (!variables.length) return "(none)";
  return variables
    .map((v) => {
      const value = v.secret ? decrypt(v.value) : v.value;
      return `- ${v.key} = ${value}`;
    })
    .join("\n");
}

// Improve a recorded spec using repo understanding, then run/heal until green.
// Returns { specCode, passed, heal, repo }.
async function improveAndHeal({ test, project, storagePath, env = null, anthropicClient = null }) {
  // Run against the selected environment's URL when given, else the legacy
  // project baseUrl.
  const runBaseUrl = env?.baseUrl || project.baseUrl;
  const client = aiUsage.tag(anthropicClient || getAnthropic(), { action: "e2e_heal", surface: "e2e" });
  const recorded = test.specCode || "";
  if (!recorded.trim()) {
    const err = new Error("This test has no recorded spec to improve yet.");
    err.statusCode = 400;
    throw err;
  }

  const repo = await buildRepoContext(project);
  dbg(
    `model=${HEAL_MODEL} maxAttempts=${MAX_ATTEMPTS} repoFiles=${repo.files} repoTestIds=${repo.testIds} repoChars=${repo.text.length}`
  );

  // Stable prefix (system prompt + repo snapshot) is prompt-cached so every heal
  // iteration only pays for the cheap cache read, not the whole repo again.
  const system = [{ type: "text", text: SENIOR_SYSTEM_PROMPT }];
  if (repo.text) {
    system.push({ type: "text", text: repo.text, cache_control: { type: "ephemeral" } });
  }
  dbgBlock("SYSTEM PROMPT", SENIOR_SYSTEM_PROMPT);
  if (repo.text) dbgBlock("REPO CONTEXT (cached)", repo.text);

  const task = [
    "INTENDED BEHAVIOR (Gherkin):",
    renderGherkin(test.gherkin, test.gherkinText),
    "",
    "AVAILABLE TEST DATA (you may use these values):",
    renderVariables(project.variables),
    "",
    "RECORDED SPEC (raw UI movements from codegen — rewrite this):",
    "```typescript",
    recorded,
    "```",
  ].join("\n");

  const messages = [{ role: "user", content: task }];
  dbgBlock("USER MESSAGE (task: gherkin + vars + recorded spec)", task);
  const heal = [];
  let lastSpec = recorded;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    dbg(`--- attempt ${attempt}/${MAX_ATTEMPTS}: sending ${messages.length} message(s) to Claude ---`);
    const resp = await client.messages.create({
      model: HEAL_MODEL,
      max_tokens: 8000,
      system,
      messages,
    });
    const text = extractText(resp);
    dbgBlock(`CLAUDE RESPONSE (attempt ${attempt})`, text);
    dbg(
      `usage attempt ${attempt}:`,
      `in=${resp.usage?.input_tokens || 0}`,
      `out=${resp.usage?.output_tokens || 0}`,
      `cacheWrite=${resp.usage?.cache_creation_input_tokens || 0}`,
      `cacheRead=${resp.usage?.cache_read_input_tokens || 0}`
    );
    const spec = extractCode(text) || lastSpec;
    lastSpec = spec;

    const t0 = Date.now();
    const run = await runSpec(spec, {
      baseUrl: runBaseUrl,
      storagePath,
      testId: test._id,
    });
    heal.push({
      attempt,
      passed: run.passed,
      error: run.error || "",
      durationMs: Date.now() - t0,
      traceUrl: run.traceUrl || "",
    });

    dbg(`attempt ${attempt} run: passed=${run.passed} durationMs=${Date.now() - t0}`);
    if (run.passed) {
      dbg(`✓ green on attempt ${attempt}`);
      return { specCode: spec, passed: true, heal, repo };
    }
    dbgBlock(`PLAYWRIGHT FAILURE (attempt ${attempt}) → fed back to Claude`, run.error || "(no error text)");

    // Feed the failure back; keep the cached prefix intact by only growing
    // messages.
    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content:
        `The test FAILED when executed. Diagnose the error and return the FULL corrected spec in one \`\`\`typescript block.\n\n` +
        `Error output:\n"""\n${run.error}\n"""`,
    });
  }

  return { specCode: lastSpec, passed: false, heal, repo };
}

module.exports = { improveAndHeal };
