const aiUsage = require("../services/aiUsageService");
const usageLimit = require("../services/usageLimitService");
const AiUsage = require("../model/AiUsageModel");

// What this workspace has spent on Claude, and how close it is to its plan.
async function getUsage(req, res) {
  if (!req.user?.companyId) {
    return res.status(400).json({ message: "User has no company" });
  }
  const [limit, spend] = await Promise.all([
    usageLimit.status(req.user.companyId),
    aiUsage.spendSince(req.user.companyId),
  ]);

  // Where the money went, by repo / MCP project — the view that answers "which
  // customer or which repo is expensive".
  const byScope = await AiUsage.aggregate([
    {
      $match: {
        companyId: req.user.companyId,
        createdAt: { $gte: aiUsage.startOfMonth() },
      },
    },
    {
      $group: {
        _id: { surface: "$surface", owner: "$owner", repo: "$repo", projectId: "$projectId" },
        costUsd: { $sum: "$costUsd" },
        calls: { $sum: 1 },
      },
    },
    { $sort: { costUsd: -1 } },
    { $limit: 20 },
  ]);

  res.json({
    ...limit,
    calls: spend.calls,
    byAction: spend.byAction,
    byScope: byScope.map((r) => ({
      surface: r._id.surface,
      owner: r._id.owner,
      repo: r._id.repo,
      projectId: r._id.projectId,
      costUsd: r.costUsd,
      calls: r.calls,
    })),
  });
}

module.exports = { getUsage };
