const usageLimit = require("../services/usageLimitService");

// Stop work that spends money on Claude when the workspace has used up its
// monthly AI budget.
//
// Applied at the ROUTE, not inside each controller: the expensive endpoints are
// a known list, and a gate that lives next to the route is one a reviewer can
// see. 402 (Payment Required) so the client can tell this apart from a bug.
// Usable two ways: `requireBudget` on its own, or `requireBudget("mcp")` to say
// which half of the product the route belongs to (for plans that only include
// one of them).
function requireBudget(surfaceOrReq, res, next) {
  if (typeof surfaceOrReq === "string" || surfaceOrReq === undefined) {
    const surface = surfaceOrReq || null;
    return (req, res2, next2) => check(req, res2, next2, surface);
  }
  return check(surfaceOrReq, res, next, null);
}

async function check(req, res, next, surface) {
  try {
    await usageLimit.assertWithinBudget(req.user?.companyId, surface);
    next();
  } catch (err) {
    if (err.code === "AI_BUDGET_EXCEEDED") {
      return res.status(402).json({ code: err.code, message: err.message });
    }
    if (err.code === "PLAN_SURFACE_NOT_INCLUDED") {
      return res.status(403).json({ code: err.code, message: err.message });
    }
    next();
  }
}

module.exports = { requireBudget };
