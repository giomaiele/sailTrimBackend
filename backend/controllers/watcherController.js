const ApiWatcher = require("../model/ApiWatcherModel");
const WatcherRun = require("../model/WatcherRunModel");
const Doc = require("../model/DocModel");
const Installation = require("../model/Installation");
const watcherService = require("../services/watcherService");
const Company = require("../model/companyModel");
const usageLimit = require("../services/usageLimitService");
const { getOctokit, getDefaultBranch } = require("../services/githubService");

function requireCompany(req, res) {
  if (!req.user.companyId) {
    res.status(400).json({ message: "User has no company" });
    return false;
  }
  return true;
}

// Watchers are a paid capability. Checked on the company, not the user, so a
// teammate can't create one the workspace isn't paying for.
// Watchers are a plan FEATURE now (see usageLimitService.PLANS), not a
// hard-coded "pro" — so adding a plan that includes them is a table edit, not a
// hunt through controllers. Name kept: it's called from the MCP side too.
async function requirePro(req, res) {
  const company = await Company.findById(req.user.companyId).select("plan").lean();
  const plan = company?.plan || "free";
  if (!usageLimit.allowsFeature(plan, "watchers")) {
    res.status(402).json({
      code: "PLAN_FEATURE_NOT_INCLUDED",
      message:
        "Watchers aren't included in this plan. Contact the provider to upgrade.",
      plan,
      required: "pro",
    });
    return false;
  }
  return true;
}

// A watch on a branch that doesn't exist is the worst kind of broken: it looks
// configured, never fires, and gives no sign anything is wrong. Check the branch
// against GitHub up front and refuse, naming the default so the fix is obvious.
//
// Returns an error string, or "" when the branch is fine. A GitHub outage must
// not block creating a watcher, so an unreachable API is treated as "can't
// verify" rather than "invalid".
async function branchProblem(installationId, owner, repo, branch) {
  try {
    const octokit = await getOctokit(installationId);
    try {
      await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
        owner,
        repo,
        branch,
      });
      return "";
    } catch (err) {
      if (err.status !== 404) throw err;
      let suggestion = "";
      try {
        suggestion = await getDefaultBranch(octokit, owner, repo);
      } catch (_) {
        /* the suggestion is a nicety, not worth failing over */
      }
      return (
        `${owner}/${repo} has no branch called "${branch}"` +
        (suggestion ? `. Its default branch is "${suggestion}".` : ".")
      );
    }
  } catch (err) {
    console.error("[watcher] branch check failed:", err.message);
    return ""; // couldn't verify — let it through rather than block on GitHub
  }
}

// A run older than this still marked pending/running died without finishing
// (the process was killed mid-run); don't keep telling the user it's running.
const ACTIVE_RUN_MAX_AGE_MS = 3 * 60 * 60 * 1000;

function cleanWatcherName(raw) {
  return String(raw || "").trim().slice(0, 80);
}

// Runs in flight for one repo, so its docs page can say "a watcher is running".
async function listActiveRuns(req, res) {
  if (!requireCompany(req, res)) return;
  const { owner, repo } = req.query;
  if (!owner || !repo) {
    return res.status(400).json({ message: "owner and repo are required" });
  }
  const runs = await WatcherRun.find({
    companyId: req.user.companyId,
    owner,
    repo,
    status: { $in: ["pending", "running"] },
    createdAt: { $gte: new Date(Date.now() - ACTIVE_RUN_MAX_AGE_MS) },
  })
    .select("watcherId status trigger startedAt createdAt")
    .sort({ createdAt: -1 })
    .lean();
  const watchers = await ApiWatcher.find({ _id: { $in: runs.map((r) => r.watcherId) } })
    .select("name branch")
    .lean();
  const byId = new Map(watchers.map((w) => [String(w._id), w]));
  res.json(
    runs.map((r) => ({
      _id: r._id,
      status: r.status,
      watcherName: byId.get(String(r.watcherId))?.name || "",
      branch: byId.get(String(r.watcherId))?.branch || r.trigger?.branch || "",
      prNumber: r.trigger?.prNumber ?? null,
      prTitle: r.trigger?.prTitle || "",
      startedAt: r.startedAt || r.createdAt,
    }))
  );
}

async function listWatchers(req, res) {
  if (!requireCompany(req, res)) return;
  const watchers = await ApiWatcher.find({ companyId: req.user.companyId })
    .sort({ updatedAt: -1 })
    .lean();
  res.json(watchers);
}

// Start watching a repo. The installation is looked up rather than trusted from
// the body, so a watcher can't be pointed at a repo this company can't read.
async function createWatcher(req, res) {
  if (!requireCompany(req, res)) return;
  if (!(await requirePro(req, res))) return;
  const { owner, repo, branch = "main", actions } = req.body || {};
  const name = cleanWatcherName(req.body?.name);
  if (!owner || !repo) {
    return res.status(400).json({ message: "owner and repo are required" });
  }
  if (!name) {
    return res.status(400).json({ message: "Give the watcher a name." });
  }

  const installation = await Installation.findOne({
    accountLogin: owner,
    $or: [{ companyId: req.user.companyId }, { userId: req.user._id }],
  });
  if (!installation) {
    return res.status(404).json({
      message: `No connected GitHub installation for "${owner}". Connect the repo first.`,
    });
  }

  const problem = await branchProblem(
    installation.installationId,
    owner,
    repo,
    branch
  );
  if (problem) {
    return res.status(400).json({ message: problem, code: "BRANCH_NOT_FOUND" });
  }

  try {
    const watcher = await ApiWatcher.findOneAndUpdate(
      { owner, repo, branch },
      {
        $set: {
          name,
          installationId: installation.installationId,
          owner,
          repo,
          branch,
          enabled: true,
          ...(actions ? { actions } : {}),
          userId: req.user._id,
          companyId: req.user.companyId,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.status(201).json(watcher);
  } catch (err) {
    // The unique index is on (owner, repo, branch) globally, so another company
    // watching the same public repo collides. Say so instead of a 500.
    if (err.code === 11000) {
      return res.status(409).json({
        message: `${owner}/${repo} is already being watched on ${branch}.`,
      });
    }
    throw err;
  }
}

async function updateWatcher(req, res) {
  if (!requireCompany(req, res)) return;
  const { enabled, actions, branch } = req.body || {};
  const watcher = await ApiWatcher.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!watcher) return res.status(404).json({ message: "Watcher not found" });

  if (typeof enabled === "boolean") watcher.enabled = enabled;
  if (typeof req.body?.name === "string" && cleanWatcherName(req.body.name)) {
    watcher.name = cleanWatcherName(req.body.name);
  }
  if (actions) watcher.actions = { ...watcher.actions.toObject?.() ?? watcher.actions, ...actions };
  if (branch && branch !== watcher.branch) {
    const problem = await branchProblem(
      watcher.installationId,
      watcher.owner,
      watcher.repo,
      branch
    );
    if (problem) {
      return res.status(400).json({ message: problem, code: "BRANCH_NOT_FOUND" });
    }
    watcher.branch = branch;
  }
  await watcher.save();
  res.json(watcher);
}

async function deleteWatcher(req, res) {
  if (!requireCompany(req, res)) return;
  const del = await ApiWatcher.deleteOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!del.deletedCount) return res.status(404).json({ message: "Watcher not found" });
  res.json({ success: true });
}

// "Run now" — the same work a merge triggers, on demand. Answers immediately
// with the run id because a full regeneration takes minutes; the client polls.
async function runWatcherNow(req, res) {
  if (!requireCompany(req, res)) return;
  const watcher = await ApiWatcher.findOne({
    _id: req.params.id,
    companyId: req.user.companyId,
  });
  if (!watcher) return res.status(404).json({ message: "Watcher not found" });

  if (!(await requirePro(req, res))) return;

  watcherService
    .runWatcher({ watcherId: watcher._id, trigger: { kind: "manual" } })
    .catch((err) => console.error("[watcher] manual run failed:", err.message));

  res.status(202).json({ started: true, watcherId: watcher._id });
}

async function listRuns(req, res) {
  if (!requireCompany(req, res)) return;
  const filter = { companyId: req.user.companyId };
  if (req.params.id) filter.watcherId = req.params.id;
  const runs = await WatcherRun.find(filter)
    .sort({ createdAt: -1 })
    .limit(Number(req.query.limit) || 20)
    .lean();
  res.json(runs);
}

// Endpoints the watcher flagged since anyone last looked.
async function listNewEndpoints(req, res) {
  if (!requireCompany(req, res)) return;
  const docs = await Doc.find({
    companyId: req.user.companyId,
    isNewEndpoint: true,
  })
    .select("method path owner repo firstSeenAt firstSeenPr")
    .sort({ firstSeenAt: -1 })
    .lean();
  res.json(docs);
}

// Clear the flag once they've been reviewed, so "what's new" keeps meaning
// "what's new since I last looked" instead of growing forever.
async function acknowledgeNewEndpoints(req, res) {
  if (!requireCompany(req, res)) return;
  const { docIds } = req.body || {};
  const filter = { companyId: req.user.companyId, isNewEndpoint: true };
  if (Array.isArray(docIds) && docIds.length) filter._id = { $in: docIds };
  const r = await Doc.updateMany(filter, { $set: { isNewEndpoint: false } });
  res.json({ cleared: r.modifiedCount });
}

module.exports = {
  listWatchers,
  listActiveRuns,
  cleanWatcherName,
  ACTIVE_RUN_MAX_AGE_MS,
  createWatcher,
  updateWatcher,
  deleteWatcher,
  runWatcherNow,
  listRuns,
  listNewEndpoints,
  acknowledgeNewEndpoints,
  // Shared with the MCP watcher controller so both enforce the same plan and
  // the same branch check, instead of two copies that can drift.
  requirePro,
  branchProblem,
};
