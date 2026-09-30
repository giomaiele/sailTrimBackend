const Anthropic = require("@anthropic-ai/sdk");
const User = require("../model/userModel.js");
const Company = require("../model/companyModel.js");
const { decrypt } = require("./secretCrypto.js");
const aiUsage = require("./aiUsageService.js");

// Whose Anthropic account pays for a piece of work.
//
// Order: the WORKSPACE's key, then the user's own (kept for the people who set
// one before workspace keys existed), then null — which means the caller falls
// back to Olivia's platform key and the spend counts against their plan.
//
// Company first is the whole point: "bring your own key" is something a company
// buys, so it has to apply to every member and to the watchers that run with
// nobody logged in. With the key on the user, half a team's work quietly billed
// Olivia and the other half billed one employee's personal account.
function clientFor(apiKey, ctx) {
  return aiUsage.meter(new Anthropic({ apiKey }), { payer: "customer", ...ctx });
}

/**
 * @param userId     who triggered the work (may be null for background runs)
 * @param companyId  the workspace it belongs to — pass it whenever it's known
 */
async function getAnthropicClientFor({ userId = null, companyId = null } = {}) {
  let resolvedCompanyId = companyId;
  let user = null;

  if (userId) {
    user = await User.findById(userId).select("anthropicKeyEncrypted companyId");
    if (!resolvedCompanyId) resolvedCompanyId = user?.companyId || null;
  }

  if (resolvedCompanyId) {
    const company = await Company.findById(resolvedCompanyId).select(
      "anthropicKeyEncrypted"
    );
    const key = company?.anthropicKeyEncrypted && decrypt(company.anthropicKeyEncrypted);
    if (key) {
      return clientFor(key, { userId, companyId: resolvedCompanyId });
    }
  }

  const personal = user?.anthropicKeyEncrypted && decrypt(user.anthropicKeyEncrypted);
  if (personal) {
    return clientFor(personal, { userId, companyId: resolvedCompanyId });
  }

  return null;
}

// The old name, kept so existing call sites keep working. It now checks the
// workspace key first, which is the fix.
async function getUserAnthropicClient(userId) {
  return getAnthropicClientFor({ userId });
}

module.exports = { getAnthropicClientFor, getUserAnthropicClient };
