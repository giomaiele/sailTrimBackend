const Company = require("../model/companyModel");
const User = require("../model/userModel");
const AiUsage = require("../model/AiUsageModel");
const aiUsage = require("../services/aiUsageService");
const usageLimit = require("../services/usageLimitService");
const { logEvent } = require("../services/auditLogger");
const AiUsageModel = require("../model/AiUsageModel");

// Back office for the operator: who the customers are, what they're spending,
// and which plan they're on. Plans are changed by hand here because there is no
// billing yet — Stripe replaces the write side of this later, not the read side.

/** Every workspace, with this month's spend against its budget. */
async function listCompanies(req, res) {
  const companies = await Company.find({})
    .select("name plan aiBudgetUsd planNote createdAt ownerUserId")
    .sort({ createdAt: -1 })
    .lean();

  const since = aiUsage.startOfMonth();
  const [spendRows, memberRows, owners] = await Promise.all([
    AiUsage.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { companyId: "$companyId", payer: "$payer" },
          costUsd: { $sum: "$costUsd" },
          calls: { $sum: 1 },
        },
      },
    ]),
    User.aggregate([
      { $match: { companyId: { $ne: null } } },
      { $group: { _id: "$companyId", members: { $sum: 1 } } },
    ]),
    User.find({ _id: { $in: companies.map((c) => c.ownerUserId) } })
      .select("email firstName lastName")
      .lean(),
  ]);

  const spendBy = new Map();
  for (const r of spendRows) {
    const key = String(r._id.companyId);
    const cur = spendBy.get(key) || { platformUsd: 0, customerUsd: 0, calls: 0 };
    if (r._id.payer === "customer") cur.customerUsd += r.costUsd;
    else cur.platformUsd += r.costUsd;
    cur.calls += r.calls;
    spendBy.set(key, cur);
  }
  const membersBy = new Map(memberRows.map((r) => [String(r._id), r.members]));
  const ownerBy = new Map(owners.map((u) => [String(u._id), u]));

  res.json(
    companies.map((c) => {
      const spend = spendBy.get(String(c._id)) || {
        platformUsd: 0,
        customerUsd: 0,
        calls: 0,
      };
      const limitUsd =
        typeof c.aiBudgetUsd === "number" && c.aiBudgetUsd >= 0
          ? c.aiBudgetUsd
          : usageLimit.limitsFor(c.plan).monthlyAiUsd;
      const owner = ownerBy.get(String(c.ownerUserId));
      return {
        _id: c._id,
        name: c.name,
        plan: c.plan,
        // What this plan lets them use — api, mcp, automation, watchers.
        features: usageLimit.featuresOf(c.plan),
        aiBudgetUsd: c.aiBudgetUsd ?? null,
        planNote: c.planNote || "",
        createdAt: c.createdAt,
        ownerEmail: owner?.email || "",
        members: membersBy.get(String(c._id)) || 0,
        // What Olivia paid for, what the customer's own key paid for, and where
        // that leaves them against their budget.
        spentUsd: spend.platformUsd,
        ownKeyUsd: spend.customerUsd,
        calls: spend.calls,
        limitUsd,
        percent: limitUsd ? Math.round((spend.platformUsd / limitUsd) * 100) : 0,
      };
    })
  );
}

/** Where one workspace's money went this month. */
async function companyUsage(req, res) {
  const companyId = req.params.id;
  const [limit, spend] = await Promise.all([
    usageLimit.status(companyId),
    aiUsage.spendSince(companyId),
  ]);
  res.json({ ...limit, byAction: spend.byAction, calls: spend.calls });
}

/** Change a workspace's plan, its budget override, or the note explaining why. */
async function updateCompanyPlan(req, res) {
  const { plan, aiBudgetUsd, planNote } = req.body || {};
  const update = {};

  if (plan !== undefined) {
    if (!["free", "pro", "enterprise", "test"].includes(plan)) {
      return res.status(400).json({ message: `Unknown plan "${plan}"` });
    }
    update.plan = plan;
  }
  if (aiBudgetUsd !== undefined) {
    // null clears the override and puts the company back on its tier's budget.
    if (aiBudgetUsd === null || aiBudgetUsd === "") update.aiBudgetUsd = null;
    else if (Number.isFinite(Number(aiBudgetUsd)) && Number(aiBudgetUsd) >= 0) {
      update.aiBudgetUsd = Number(aiBudgetUsd);
    } else {
      return res.status(400).json({ message: "aiBudgetUsd must be a number ≥ 0" });
    }
  }
  if (planNote !== undefined) update.planNote = String(planNote).slice(0, 300);

  const company = await Company.findByIdAndUpdate(req.params.id, update, {
    new: true,
  }).select("name plan aiBudgetUsd planNote");
  if (!company) return res.status(404).json({ message: "Company not found" });

  // Money decisions made by hand need a trail even when only one person can
  // make them.
  await logEvent({
    event: "admin_plan_changed",
    req,
    user: null,
    targetType: "Company",
    targetId: String(company._id),
    metadata: { ...update, companyName: company.name },
  }).catch(() => {});

  res.json(company);
}

/**
 * Add fake spend to a workspace, to see the limit actually bite.
 *
 * Testing a $5 ceiling by generating $5 of real docs costs $5 and twenty
 * minutes. This writes rows that look exactly like real ones (they're priced by
 * the same function) with action "simulated", so the gate, the admin page and
 * the customer's error message can all be checked in seconds. `DELETE` on the
 * same route removes them again.
 */
async function simulateSpend(req, res) {
  const usd = Number(req.body?.usd);
  if (!Number.isFinite(usd) || usd <= 0) {
    return res.status(400).json({ message: "usd must be a number > 0" });
  }
  const company = await Company.findById(req.params.id).select("_id").lean();
  if (!company) return res.status(404).json({ message: "Company not found" });

  await AiUsageModel.create({
    action: "simulated",
    model: "simulated",
    tokensIn: 0,
    tokensOut: 0,
    costUsd: usd,
    payer: "platform",
    surface: "other",
    companyId: company._id,
  });

  res.json(await usageLimit.status(company._id));
}

async function clearSimulatedSpend(req, res) {
  const r = await AiUsageModel.deleteMany({
    companyId: req.params.id,
    action: "simulated",
  });
  res.json({ removed: r.deletedCount, ...(await usageLimit.status(req.params.id)) });
}

module.exports = {
  listCompanies,
  companyUsage,
  updateCompanyPlan,
  simulateSpend,
  clearSimulatedSpend,
};
