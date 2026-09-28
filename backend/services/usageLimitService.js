const Company = require("../model/companyModel");
const AiUsage = require("../model/AiUsageModel");
const aiUsage = require("./aiUsageService");

// What a plan is allowed to spend on Claude in a month, and the check that
// stops a customer from quietly costing more than they pay.
//
// The unit is DOLLARS, not runs. Runs vary from $0.30 to $9 depending on how
// much code a merge touched, so "300 merges" is not a budget — it's a guess
// that happens to be right for small repos and ruinous for large ones.
//
// The existing MCP free-trial counters (McpUsageEvent) count forever and never
// reset, which is why a free trial there can never come back. These are windowed
// to the calendar month on purpose.
// A plan is two things: how much Claude it may spend in a month, and WHICH
// parts of Olivia it may use. Both live here, in one table, so "what does this
// plan include?" is answered by reading four lines instead of grepping for
// plan checks scattered across controllers.
//
// features: api = endpoint docs, tests and bug hunter on connected repos.
//           mcp = the MCP side (tools, docs, tests, bug hunter).
//           automation = the E2E / Playwright side.
//           watchers = the agent that fires on merge, for both api and mcp.
// mcpQuotas caps how many times a month the MCP actions can run, on top of the
// money. It exists for the free trial: someone evaluating the product should
// see it work, not burn a month's budget in one afternoon. Paid plans set it to
// null — their only ceiling is the dollar budget.
const PLANS = {
  free: {
    monthlyAiUsd: 10,
    features: ["api", "mcp", "automation"],
    mcpQuotas: {
      projects: 2,
      docs_generate: 3,
      qa_run: 5,
      smoke_generate: 3,
      smoke_run: 5,
      regression_generate: 3,
      regression_run: 5,
      profile_run: 3,
      load_run: 3,
      security_scan: 3,
    },
  },
  // MCP only, for trying the MCP half on its own.
  test: {
    monthlyAiUsd: 5,
    features: ["mcp"],
    mcpQuotas: null,
  },
  pro: {
    monthlyAiUsd: 150,
    features: ["api", "mcp", "automation", "watchers"],
    mcpQuotas: null,
  },
  enterprise: {
    monthlyAiUsd: 500,
    features: ["api", "mcp", "automation", "watchers"],
    mcpQuotas: null,
  },
};

const ALL_FEATURES = ["api", "mcp", "automation", "watchers"];

// A customer paying with their OWN Anthropic key costs Olivia nothing, so their
// spend is recorded but never counted against the plan.
const PAYER_FILTER = { payer: "platform" };

function limitsFor(plan) {
  return PLANS[plan] || PLANS.free;
}

/**
 * How many times a month a plan may run one MCP action, or null for "as many
 * as the budget allows".
 */
function mcpQuotaFor(plan, action) {
  const quotas = limitsFor(plan).mcpQuotas;
  if (!quotas) return null;
  return quotas[action] ?? null;
}

/** Which parts of Olivia a plan includes. */
function featuresOf(plan) {
  return limitsFor(plan).features || ALL_FEATURES;
}

/** Whether a plan includes a part ("api", "mcp", "automation", "watchers"). */
function allowsFeature(plan, feature) {
  if (!feature) return true;
  return featuresOf(plan).includes(feature);
}

// Kept for callers that speak in surfaces ("api" / "mcp") — same question.
const allowsSurface = allowsFeature;

/** What this company has spent this month on Olivia's key. */
async function spentThisMonth(companyId) {
  const [row] = await AiUsage.aggregate([
    {
      $match: {
        companyId,
        ...PAYER_FILTER,
        createdAt: { $gte: aiUsage.startOfMonth() },
      },
    },
    { $group: { _id: null, costUsd: { $sum: "$costUsd" } } },
  ]);
  return row?.costUsd || 0;
}

/**
 * Where a company stands this month: what they've spent, what they may spend,
 * and whether the next piece of work is allowed to start.
 */
async function status(companyId) {
  const company = await Company.findById(companyId).select("plan aiBudgetUsd").lean();
  const plan = company?.plan || "free";
  // A per-company override beats the tier: deals are negotiated one at a time
  // while there's no billing system.
  const monthlyAiUsd =
    typeof company?.aiBudgetUsd === "number" && company.aiBudgetUsd >= 0
      ? company.aiBudgetUsd
      : limitsFor(plan).monthlyAiUsd;
  const spentUsd = await spentThisMonth(companyId);
  return {
    plan,
    spentUsd,
    limitUsd: monthlyAiUsd,
    remainingUsd: Math.max(0, monthlyAiUsd - spentUsd),
    overLimit: spentUsd >= monthlyAiUsd,
    percent: monthlyAiUsd ? Math.round((spentUsd / monthlyAiUsd) * 100) : 0,
    since: aiUsage.startOfMonth(),
  };
}

/**
 * The gate. Checked BEFORE starting work that will spend money — a regeneration,
 * a suite generation, a bug hunter run, a watcher firing.
 *
 * Deliberately coarse: it stops the NEXT piece of work, it doesn't interrupt one
 * in flight. A run cut in half leaves half-written docs, which is worse for the
 * customer than one run of overspend is for us.
 *
 * `surface` is the half of the product the work belongs to, for plans that only
 * include one of them.
 */
async function assertWithinBudget(companyId, surface = null) {
  if (!companyId) return; // no company, no plan to enforce
  const s = await status(companyId);

  if (!allowsFeature(s.plan, surface)) {
    const names = {
      api: "the API side",
      mcp: "the MCP side",
      automation: "the automation side",
      watchers: "watchers",
    };
    const err = new Error(
      `The "${s.plan}" plan doesn't include ${names[surface] || surface}. ` +
        `Upgrade the plan to use it.`
    );
    err.statusCode = 403;
    err.code = "PLAN_SURFACE_NOT_INCLUDED";
    throw err;
  }

  if (!s.overLimit) return s;
  const err = new Error(
    `This workspace has used its monthly AI budget ($${s.limitUsd}). ` +
      `It resets at the start of next month. Contact the provider to upgrade.`
  );
  err.statusCode = 402;
  err.code = "AI_BUDGET_EXCEEDED";
  throw err;
}

/** Same check, for callers that must not throw (webhooks, background runs). */
async function withinBudget(companyId, surface = null) {
  try {
    await assertWithinBudget(companyId, surface);
    return true;
  } catch (err) {
    if (err.code === "AI_BUDGET_EXCEEDED") return false;
    if (err.code === "PLAN_SURFACE_NOT_INCLUDED") return false;
    // A database problem must not silently switch the product off.
    console.error("[usage-limit] check failed:", err.message);
    return true;
  }
}

module.exports = {
  PLANS,
  ALL_FEATURES,
  limitsFor,
  mcpQuotaFor,
  featuresOf,
  allowsFeature,
  allowsSurface,
  status,
  spentThisMonth,
  assertWithinBudget,
  withinBudget,
};
