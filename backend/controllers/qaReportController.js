const crypto = require("crypto");
const report = require("../services/qaReportService");
const ShareLink = require("../model/ShareLinkModel");
const { logEvent } = require("../services/auditLogger");

function requireCompany(req, res) {
  if (!req.user?.companyId) {
    res.status(400).json({ message: "User has no company" });
    return false;
  }
  return true;
}

// Which report the caller is asking for, from the route params. Kept in one
// place because three routes and the share link all have to agree on it.
function scopeFromParams(req) {
  const { owner, repo, id } = req.params;
  // An MCP project id and an imported API project id look the same in the URL,
  // so the caller says which surface it means.
  if (req.query.surface === "mcp" || req.body?.surface === "mcp") {
    return { surface: "mcp", projectId: id };
  }
  if (owner && repo) return { surface: "api", owner, repo };
  return { surface: "api", projectId: id };
}

async function buildFor({ scope, companyId, from, to }) {
  if (scope.surface === "mcp") {
    return report.mcpReport({ companyId, projectId: scope.projectId, from, to });
  }
  return report.apiReport({
    companyId,
    owner: scope.owner,
    repo: scope.repo,
    projectId: scope.projectId || null,
    from,
    to,
  });
}

async function getReport(req, res) {
  if (!requireCompany(req, res)) return;
  try {
    const data = await buildFor({
      scope: scopeFromParams(req),
      companyId: req.user.companyId,
      from: req.query.from,
      to: req.query.to,
    });
    res.json(data);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("getReport error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

// Mint a link the customer can forward. The token is the credential, so it's
// 32 random bytes — long enough that guessing one is not a strategy.
async function createShareLink(req, res) {
  if (!requireCompany(req, res)) return;
  try {
    const scope = scopeFromParams(req);
    // Build it once before sharing: a link to a report that throws is worse
    // than an error here.
    await buildFor({
      scope,
      companyId: req.user.companyId,
      from: req.body?.from,
      to: req.body?.to,
    });

    const link = await ShareLink.create({
      token: crypto.randomBytes(24).toString("base64url"),
      kind: "qa-report",
      scope: {
        surface: scope.surface,
        owner: scope.owner || "",
        repo: scope.repo || "",
        projectId: scope.projectId || null,
      },
      period: {
        from: req.body?.from ? new Date(req.body.from) : null,
        to: req.body?.to ? new Date(req.body.to) : null,
      },
      label: String(req.body?.label || "").slice(0, 120),
      expiresAt: req.body?.expiresAt ? new Date(req.body.expiresAt) : null,
      createdBy: req.user._id,
      companyId: req.user.companyId,
    });

    await logEvent({
      event: "qa_report_shared",
      req,
      user: req.user,
      targetType: "ShareLink",
      targetId: String(link._id),
      metadata: { surface: scope.surface, owner: scope.owner, repo: scope.repo },
    });

    res.status(201).json({ token: link.token, expiresAt: link.expiresAt });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error("createShareLink error:", err);
    res.status(status).json({ message: err.message || "Internal error" });
  }
}

async function listShareLinks(req, res) {
  if (!requireCompany(req, res)) return;
  const scope = scopeFromParams(req);
  const filter = {
    companyId: req.user.companyId,
    revokedAt: null,
    "scope.surface": scope.surface,
  };
  if (scope.projectId) filter["scope.projectId"] = scope.projectId;
  else {
    filter["scope.owner"] = scope.owner;
    filter["scope.repo"] = scope.repo;
  }
  const links = await ShareLink.find(filter)
    .select("token label period expiresAt views lastViewedAt createdAt")
    .sort({ createdAt: -1 })
    .lean();
  res.json(links);
}

async function revokeShareLink(req, res) {
  if (!requireCompany(req, res)) return;
  const link = await ShareLink.findOneAndUpdate(
    { token: req.params.token, companyId: req.user.companyId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  if (!link) return res.status(404).json({ message: "Link not found" });
  res.json({ success: true });
}

// PUBLIC — no session. Everything it can reach is decided by the stored scope,
// never by anything the caller sends, so a token can't be pointed at another
// company's data.
async function getSharedReport(req, res) {
  try {
    const link = await ShareLink.findOne({
      token: req.params.token,
      kind: "qa-report",
      revokedAt: null,
    });
    if (!link || (link.expiresAt && link.expiresAt < new Date())) {
      return res.status(404).json({ message: "This link is no longer available." });
    }

    const data = await buildFor({
      scope: {
        surface: link.scope.surface,
        owner: link.scope.owner,
        repo: link.scope.repo,
        projectId: link.scope.projectId,
      },
      companyId: link.companyId,
      from: link.period?.from,
      to: link.period?.to,
    });

    // Best-effort: a failed counter must not cost the reader their report.
    ShareLink.updateOne(
      { _id: link._id },
      { $inc: { views: 1 }, $set: { lastViewedAt: new Date() } }
    ).catch(() => {});

    res.json({ ...data, shared: true, label: link.label || "" });
  } catch (err) {
    console.error("getSharedReport error:", err);
    res.status(500).json({ message: "Could not load this report." });
  }
}

module.exports = {
  getReport,
  createShareLink,
  listShareLinks,
  revokeShareLink,
  getSharedReport,
};
