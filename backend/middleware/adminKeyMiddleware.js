const crypto = require("crypto");

// The back office: one shared key, held by the operator, no user session.
//
// It is NOT a user login on purpose — these endpoints change what customers are
// allowed to spend, and tying that to a normal account means one compromised
// customer login away from someone editing their own plan.
//
// OLIVIA_ADMIN_KEY unset = the whole back office is off. A default would ship a
// known password to production, which is how this kind of thing goes wrong.
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // crypto.timingSafeEqual throws on length mismatch, which by itself leaks the
  // length — hash first so both sides are always 32 bytes.
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(bufA).digest(),
    crypto.createHash("sha256").update(bufB).digest()
  );
}

function requireAdminKey(req, res, next) {
  const expected = process.env.OLIVIA_ADMIN_KEY;
  if (!expected) {
    return res.status(404).json({ message: "Not found" });
  }
  const given =
    req.headers["x-olivia-admin-key"] ||
    (req.headers.authorization || "").replace(/^Bearer /i, "");

  if (!given || !timingSafeEqual(given, expected)) {
    // Same answer for "no key" and "wrong key": nothing to probe.
    return res.status(401).json({ message: "Invalid admin key" });
  }
  next();
}

module.exports = { requireAdminKey };
