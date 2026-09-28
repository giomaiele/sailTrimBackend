const Anthropic = require("@anthropic-ai/sdk");
const User = require("../model/userModel.js");
const { decrypt } = require("./secretCrypto.js");
const aiUsage = require("./aiUsageService.js");

// The customer's OWN Anthropic key, when they've set one. Two things follow
// from that: their code is read by THEIR Claude account (the answer to "does
// Olivia keep our source?"), and the tokens are billed to them, not to us.
//
// Metered all the same — spend we don't pay for is still the number that says
// whether a customer is expensive, and it's what makes "bring your own key"
// visible as a discount rather than a blind spot.
async function getUserAnthropicClient(userId) {
  if (!userId) return null;
  const user = await User.findById(userId).select("anthropicKeyEncrypted companyId");
  if (!user?.anthropicKeyEncrypted) return null;
  const apiKey = decrypt(user.anthropicKeyEncrypted);
  if (!apiKey) return null;
  return aiUsage.meter(new Anthropic({ apiKey }), {
    payer: "customer",
    userId,
    companyId: user.companyId || null,
  });
}

module.exports = { getUserAnthropicClient };
