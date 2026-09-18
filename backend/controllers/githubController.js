const jwt = require("jsonwebtoken");
const Installation = require("../model/Installation");
const BackfillJob = require("../model/BackfillJob");
const Doc = require("../model/DocModel");
const User = require("../model/userModel");
const {
  getApp,
  getOctokit,
  scanRepoTree,
  fetchBlobContent,
  fetchMountContext,
  fetchSchemaContext,
  pickSchemasForFile,
  fileLooksLikeApi,
  extractMountedModulePaths,
  extractMountPrefixes,
  isOrphanRouteFile,
  fetchInstallationRepos,
  withoutRemovedRepos,
  MAX_FILE_BYTES,
} = require("../services/githubService");
const {
  generateDocsFromFile,
  saveBackfillDocs,
  cleanupZombieDocs,
  CLAUDE_MODEL,
} = require("../services/docService");
const { getUserAnthropicClient } = require("../services/userKeyService");
const { renderGithubResultPage } = require("../views/githubResultPage");
const PendingInstall = require("../model/PendingInstall");
const { saveUserGithubTokens } = require("../services/githubUserTokenService");

const CONCURRENCY = 2;

const EXCLUDED_DIRS = [
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  "__tests__",
  "test",
  "tests",
  "spec",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  "target",
  "bin",
  "obj",
  "out",
];
const SOURCE_EXTENSIONS = [
  ".js", ".ts", ".mjs", ".cjs", ".tsx", ".jsx",
  ".py",
  ".rb",
  ".go",
  ".java", ".kt",
  ".php",
  ".cs",
  ".rs",
  ".ex", ".exs",
  ".scala",
  ".swift",
];

function isExcludedPath(p) {
  const parts = p.split("/");
  return (
    parts.some((part) => EXCLUDED_DIRS.includes(part)) ||
    p.endsWith(".min.js") ||
    /\.(test|spec)\.[jt]sx?$/.test(p) ||
    /_test\.(go|py|rb)$/.test(p) ||
    /_spec\.rb$/.test(p)
  );
}
function hasSourceExtension(p) {
  return SOURCE_EXTENSIONS.some((ext) => p.endsWith(ext));
}

// `state` used to be the raw user id, sitting in plain view in the
// "Connect GitHub" URL — anyone could hand-craft that URL with someone
// else's id and our callback would trust it blindly. Instead we sign it as
// a short-lived, purpose-scoped token: only our server can mint one (via
// getConnectLink, behind `protect`), and the callback verifies it instead
// of trusting it. 15 minutes is plenty for "click connect -> pick org on
// GitHub -> come back"; reuse within that window is allowed (stateless
// JWT, no single-use tracking) since the blast radius of a leaked link is
// already capped by the short expiry.
const CONNECT_STATE_PURPOSE = "github_connect";
const CONNECT_STATE_TTL = "15m";

// "reauth" is a sign-in-only hop: capture the user's GitHub token and send them
// straight back to Olivia, instead of on to the install screen. Used when an
// action needs the user's own token (removing a repo) and none is stored.
const REAUTH_STATE_PURPOSE = "github_reauth";

function signConnectState(userId, { purpose = CONNECT_STATE_PURPOSE, returnTo = "" } = {}) {
  return jwt.sign(
    { sub: String(userId), purpose, returnTo },
    process.env.JWT_SECRET_NODE,
    { expiresIn: CONNECT_STATE_TTL }
  );
}

// Returns the user id encoded in `state` only if it's a real, unexpired
// token we issued for this exact purpose — null for anything else
// (missing, malformed, expired, or a token issued for something else).
// Callers treat null the same as "no state" rather than throwing, so a
// bad/expired state degrades to an unlinked installation instead of a hard
// failure.
function resolveStatePayload(state) {
  if (!state) return null;
  try {
    const decoded = jwt.verify(state, process.env.JWT_SECRET_NODE);
    if (![CONNECT_STATE_PURPOSE, REAUTH_STATE_PURPOSE].includes(decoded.purpose)) {
      return null;
    }
    return decoded;
  } catch (_) {
    return null;
  }
}

function resolveStateUserId(state) {
  return resolveStatePayload(state)?.sub || null;
}

// Exchange the OAuth `code` GitHub sends when "Request user authorization
// (OAuth) during installation" is enabled, for the GitHub identity of the
// person doing the install/request. This is what lets us link an org approval
// (which arrives later, via webhook, with only `requester.id`) back to the
// exact user who asked — no guessing.
async function githubUserFromCode(code) {
  if (!code) return null;
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return null;
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
      },
    });
    const user = await userRes.json();
    if (!user?.id) return null;
    // Keep the token too — it used to be discarded here. It's what lets
    // Olivia perform the actions only a user can, like removing a repo.
    return {
      id: String(user.id),
      login: user.login,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || "",
      expiresIn: tokenData.expires_in || null,
    };
  } catch (err) {
    console.error("githubUserFromCode failed:", err.message);
    return null;
  }
}

// Attach installations that were approved for this person BEFORE we knew who
// they were on GitHub.
//
// The link between "an org owner approved a request" and "this Olivia account"
// is the requester's GitHub id, and that id only exists for us once the user
// has been through the OAuth hop below. Someone who never did — the common case
// for a teammate who was invited into a workspace and went straight to
// requesting a repo — got approved on GitHub and saw nothing in Olivia, with no
// self-service way out. The webhook parks those requester ids on the
// installation; this runs the moment we learn the id and claims them.
//
// Only installations that are still UNLINKED are claimed, so this can never
// steal an installation that already belongs to someone.
async function reconcileInstallationsForGithubUser(userId, githubUserId) {
  if (!githubUserId) return 0;

  const orphans = await Installation.find({
    pendingRequesterIds: String(githubUserId),
    userId: null,
  });

  if (orphans.length === 0) return 0;

  const user = await User.findById(userId).select("companyId");

  for (const inst of orphans) {
    inst.userId = userId;
    if (user?.companyId) inst.companyId = user.companyId;
    inst.pendingRequesterIds = inst.pendingRequesterIds.filter(
      (id) => id !== String(githubUserId)
    );
    await inst.save();
    console.log(
      `[github] reconciled installation ${inst.installationId} (${inst.accountLogin}) -> user=${userId}`
    );
  }

  return orphans.length;
}

// Authenticated endpoint the frontend calls right before sending the user
// to GitHub, instead of building the install URL itself with a raw id.
async function getConnectLink(req, res) {
  // ?purpose=reauth only signs the user in (to capture their token) and returns
  // them to `returnTo`, a same-site path — never a full URL, so this can't be
  // turned into an open redirect.
  const purpose =
    req.query.purpose === "reauth" ? REAUTH_STATE_PURPOSE : CONNECT_STATE_PURPOSE;
  const returnTo =
    typeof req.query.returnTo === "string" && /^\/(?!\/)/.test(req.query.returnTo)
      ? req.query.returnTo
      : "";
  const state = signConnectState(req.user._id, { purpose, returnTo });
  // Send the user through GitHub OAuth FIRST (not straight to the install
  // screen). GitHub does NOT return an OAuth `code` on a pending org "request"
  // — only on a completed install — so the install flow alone can't tell us who
  // requested. By authorizing first we capture their GitHub identity up front;
  // the callback then bounces them to the real install screen. GitHub uses the
  // app's registered Callback URL, so no redirect_uri is needed here.
  const clientId = process.env.GITHUB_CLIENT_ID;
  res.json({
    url: `https://github.com/login/oauth/authorize?client_id=${clientId}&state=${state}`,
  });
}

async function githubCallback(req, res) {
  const { installation_id, state: rawState, setup_action, code } = req.query;
  const frontendUrl = process.env.FRONTEND_URL;
  const state = resolveStateUserId(rawState);

  // rawState present but state resolved to null = a real token was sent but
  // it's invalid/expired/tampered — show a clear error instead of silently
  // proceeding unlinked. (No rawState at all is a different, allowed case —
  // handled further down, same as before.)
  if (rawState && !state) {
    return res
      .status(400)
      .type("html")
      .send(
        renderGithubResultPage({
          variant: "error",
          title: "This link expired",
          message:
            "This connection link is invalid or expired (links last 15 minutes). Go back to OliviaTools and click \"Connect GitHub\" again to get a fresh one.",
          ctaHref: frontendUrl || undefined,
          ctaLabel: frontendUrl ? "Back to OliviaTools" : undefined,
        })
      );
  }

  // STEP 1 of connect: the pure OAuth return (we routed them through
  // /login/oauth/authorize first). No install yet — just a `code`. Exchange it
  // for their GitHub identity, persist it on their User, then bounce them to
  // the real install screen. Capturing identity HERE (not from the install) is
  // what makes org-request linking reliable, since GitHub omits the code on a
  // pending request.
  if (code && !installation_id && setup_action !== "request") {
    if (state) {
      const ghUser = await githubUserFromCode(code);
      if (ghUser?.id) {
        await User.findByIdAndUpdate(state, {
          githubUserId: ghUser.id,
          githubUsername: ghUser.login,
        }).catch((e) => console.error("store githubUserId failed:", e.message));
        await saveUserGithubTokens(state, ghUser).catch((e) =>
          console.error("store github token failed:", e.message)
        );
        console.log(
          `[github] oauth identity captured user=${state} gh=${ghUser.login} (${ghUser.id})`
        );
        // Now that we know who they are on GitHub, pick up anything that was
        // already approved for them while they were still anonymous to us.
        const linked = await reconcileInstallationsForGithubUser(
          state,
          ghUser.id
        ).catch((e) => {
          console.error("reconcile installations failed:", e.message);
          return 0;
        });
        if (linked) {
          console.log(
            `[github] reconciled ${linked} previously-approved installation(s) for user=${state}`
          );
        }
      }
    }
    // Sign-in-only hop: token captured above, go back to Olivia.
    const payload = resolveStatePayload(rawState);
    if (payload?.purpose === REAUTH_STATE_PURPOSE && frontendUrl) {
      const to = payload.returnTo || "/workspace";
      return res.redirect(
        `${frontendUrl}${to}${to.includes("?") ? "&" : "?"}githubReauthed=1`
      );
    }
    const slug = process.env.GITHUB_APP_SLUG || "OliviaTools";
    return res.redirect(
      `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(rawState || "")}`
    );
  }

  // GitHub sends the user here with setup_action=request (and NO
  // installation_id) when they tried to install on an org where they're not
  // an admin: instead of installing, GitHub sends an approval request to the
  // org owner and the install stays pending. This is a normal, expected flow
  // for org installs — show a friendly "pending approval" page, not an error.
  if (!installation_id && setup_action === "request") {
    // Remember who asked, so the later approval webhook (which carries no
    // `state`) can link the installation back to this user. See PendingInstall.
    if (state) {
      try {
        // The GitHub identity was captured in STEP 1 (the OAuth hop) and saved
        // on the User — read it here, since GitHub gives us no `code` on a
        // request. This id is what the approval webhook matches on.
        const user = await User.findById(state).select(
          "companyId githubUserId githubUsername"
        );
        await PendingInstall.create({
          userId: state,
          companyId: user?.companyId || undefined,
          githubRequesterId: user?.githubUserId || undefined,
          githubRequesterLogin: user?.githubUsername || undefined,
        });
        console.log(
          `[github] pending recorded user=${state} ghRequester=${user?.githubUsername || "?"} (${user?.githubUserId || "no-oauth"})`
        );
      } catch (err) {
        console.error("Failed to record pending install:", err.message);
      }
    }
    return res
      .status(200)
      .type("html")
      .send(
        renderGithubResultPage({
          variant: "pending",
          title: "Request sent",
          message:
            "You requested to install OliviaTools on an organization where you're not an admin. GitHub has sent an approval request to the organization owner. Once they approve it, your connection will activate automatically.",
          ctaHref: frontendUrl || undefined,
          ctaLabel: frontendUrl ? "Back to OliviaTools" : undefined,
        })
      );
  }

  if (!installation_id) {
    return res
      .status(400)
      .type("html")
      .send(
        renderGithubResultPage({
          variant: "error",
          title: "We couldn't complete the installation",
          message:
            "GitHub didn't send an installation identifier. Please try installing the app again from OliviaTools. If the problem persists, contact us.",
          ctaHref: frontendUrl || undefined,
          ctaLabel: frontendUrl ? "Back to OliviaTools" : undefined,
        })
      );
  }

  const installationId = Number(installation_id);

  try {
    const octokit = await getOctokit(installationId);
    const ghRepos = await fetchInstallationRepos(octokit);

    const repos = ghRepos.map((r) => ({
      repoName: r.name,
      repoFullName: r.full_name,
    }));

    let accountLogin;
    let accountType;
    if (ghRepos.length > 0) {
      accountLogin = ghRepos[0].owner.login;
      accountType = ghRepos[0].owner.type;
    } else {
      const app = await getApp();
      const { data } = await app.octokit.request(
        "GET /app/installations/{installation_id}",
        { installation_id: installationId }
      );
      accountLogin = data.account.login;
      accountType = data.account.type;
    }

    const existingInstall = await Installation.findOne({ installationId }).select(
      "removedRepos"
    );
    const update = {
      installationId,
      accountLogin,
      accountType,
      repos: withoutRemovedRepos(repos, existingInstall?.removedRepos),
    };
    if (state) {
      update.userId = state;
      const user = await User.findById(state).select("companyId");
      if (user?.companyId) update.companyId = user.companyId;
    }

    await Installation.findOneAndUpdate(
      { installationId },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // With `state` this is the connecting user finishing their own install —
    // they're logged in, so send them back into the app. WITHOUT `state` it's
    // an org owner completing/approving someone else's request: they have no
    // Olivia session, so redirecting to the app just dumps them on a login.
    // Show a clear success page instead.
    if (state && frontendUrl) {
      return res.redirect(`${frontendUrl}/docs?installed=1`);
    }
    const orgName = accountLogin || "the organization";
    return res
      .status(200)
      .type("html")
      .send(
        renderGithubResultPage({
          variant: "success",
          title: "All set — connection active",
          message: state
            ? `OliviaTools is now connected. You can head back to OliviaTools.`
            : `OliviaTools is now connected for ${orgName}. The person who requested it will see the repositories in their OliviaTools automatically — you can close this tab.`,
          ctaHref: frontendUrl || undefined,
          ctaLabel: frontendUrl ? "Back to OliviaTools" : undefined,
        })
      );
  } catch (err) {
    console.error("githubCallback failed:", err);
    return res
      .status(500)
      .type("html")
      .send(
        renderGithubResultPage({
          variant: "error",
          title: "Something went wrong",
          message:
            "We couldn't finish connecting the installation. Please try again from OliviaTools, or contact us if it keeps happening.",
          ctaHref: frontendUrl || undefined,
          ctaLabel: frontendUrl ? "Back to OliviaTools" : undefined,
        })
      );
  }
}

async function runBackfill(jobId) {
  const job = await BackfillJob.findById(jobId);
  if (!job) return;

  try {
    job.status = "running";
    job.startedAt = new Date();
    job.model = CLAUDE_MODEL;
    await job.save();

    const anthropicClient = await getUserAnthropicClient(job.userId);
    const octokit = await getOctokit(job.installationId);

    // Resolve companyId for the docs we'll save. Prefer the denormalized
    // value on Installation; fall back to the User lookup for old installs.
    const installation = await Installation.findOne({
      installationId: job.installationId,
    });
    let companyId = installation?.companyId || null;
    if (!companyId && job.userId) {
      const owner = await User.findById(job.userId).select("companyId");
      companyId = owner?.companyId || null;
    }

    // 1) Full tree once — used both for mount context and candidate selection.
    const tree = await scanRepoTree(octokit, job.owner, job.repo);
    console.log(`[backfill ${job._id}] tree size:`, tree.length);
    console.log(
      `[backfill ${job._id}] first 20 paths:`,
      tree.slice(0, 20).map((n) => `${n.type}:${n.path}`)
    );

    // 2) Mount context (server.js, app.js, …) and schema context
    //    (models/, schemas/, dto/, …) fetched once and reused on every
    //    per-route Claude call so nested types get fully expanded.
    const [mountContext, schemaContext] = await Promise.all([
      fetchMountContext(octokit, job.owner, job.repo, tree),
      fetchSchemaContext(octokit, job.owner, job.repo, tree),
    ]);
    console.log(
      `[backfill ${job._id}] mount=${mountContext.length} schemas=${schemaContext.length}`
    );

    // Resolve which route files are actually required by a mount call, so
    // route files that exist in the repo but nothing ever wires up (dead
    // code) get flagged instead of documented as if they were live.
    const mountedPaths = await extractMountedModulePaths(mountContext);
    // Exact prefix per module, resolved from the entry file's AST (today:
    // JS/TS and Python) — a fact we can hand the LLM instead of asking it
    // to infer the prefix from raw mount-context text.
    const mountPrefixes = await extractMountPrefixes(mountContext);
    console.log(
      `[backfill ${job._id}] mountedPaths=${mountedPaths.size} mountPrefixes=${mountPrefixes.size}`
    );

    // 3) Pick candidates: every source file in the repo. The regex check
    //    on content (fileLooksLikeApi) does the real filtering — path
    //    structure varies too much across repos to gate on it.
    const blobs = tree.filter((n) => n.type === "blob");
    const sourceFiles = blobs.filter((n) => hasSourceExtension(n.path));
    const candidates = sourceFiles
      .filter((n) => !isExcludedPath(n.path))
      .map((n) => ({ path: n.path, sha: n.sha, size: n.size }));
    console.log(
      `[backfill ${job._id}] blobs=${blobs.length} sourceFiles=${sourceFiles.length} candidates=${candidates.length}`
    );
    console.log(
      `[backfill ${job._id}] candidate paths:`,
      candidates.map((c) => c.path)
    );

    // 4) Hydrate + pre-filter by route-regex. Skip oversized files.
    const hydrated = [];
    let skipped = 0;
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const batch = candidates.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (c) => {
          if (c.size && c.size > MAX_FILE_BYTES) {
            skipped += 1;
            return null;
          }
          try {
            const content = await fetchBlobContent(
              octokit,
              job.owner,
              job.repo,
              c.sha
            );
            if (content.length > MAX_FILE_BYTES) {
              skipped += 1;
              return null;
            }
            return fileLooksLikeApi(content) ? { ...c, content } : null;
          } catch (err) {
            console.error(`Failed to fetch blob ${c.path}:`, err.message);
            return null;
          }
        })
      );
      results.filter(Boolean).forEach((r) => hydrated.push(r));
    }

    job.filesFound = hydrated.length;
    job.filesSkipped = skipped;
    await job.save();

    // 5) Generate docs. Mount context is passed to every call so Claude can
    //    resolve prefixes like /api/user/login.
    //    sha cache: if the file's sha already has docs, we skip the Claude
    //    call and reuse the existing docs — that sha is unchanged since
    //    the last backfill, so re-processing is wasted money.
    let totalEndpoints = 0;
    let totalIn = 0;
    let totalOut = 0;
    let cachedCount = 0;
    const processedShas = [];
    const failedFiles = [];

    for (let i = 0; i < hydrated.length; i += CONCURRENCY) {
      const batch = hydrated.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (file) => {
          try {
            // sha cache check: cheap Mongo count vs expensive Claude call
            const existing = await Doc.countDocuments({
              owner: job.owner,
              repo: job.repo,
              source: "backfill",
              sourceSha: file.sha,
            });
            if (existing > 0 && !job.force) {
              return {
                saved: existing,
                usage: { inputTokens: 0, outputTokens: 0 },
                sha: file.sha,
                cached: true,
              };
            }

            const relevantSchemas = pickSchemasForFile(file.content, schemaContext);
            console.log(
              `[backfill ${job._id}] ${file.path}: schemas=${relevantSchemas.length}/${schemaContext.length}`
            );
            const normalizedPath = file.path.replace(/\.(jsx?|tsx?|py)$/i, "");
            const knownPrefix = mountPrefixes.has(normalizedPath)
              ? mountPrefixes.get(normalizedPath)
              : undefined;
            if (knownPrefix !== undefined) {
              console.log(
                `[backfill ${job._id}] ${file.path}: verified prefix "${knownPrefix}" (from AST, not a guess)`
              );
            }
            const { endpoints, usage } = await generateDocsFromFile({
              filePath: file.path,
              content: file.content,
              mountContext,
              schemaContext: relevantSchemas,
              knownPrefix,
              anthropicClient,
            });
            const orphan = isOrphanRouteFile(file.path, mountedPaths);
            if (orphan) {
              console.log(
                `[backfill ${job._id}] ${file.path}: looks like a route file but isn't mounted anywhere — flagging as unmounted`
              );
            }
            console.log(
              `[backfill ${job._id}] ${file.path}: Claude returned ${endpoints.length} endpoint(s)`
            );
            const saved = await saveBackfillDocs({
              endpoints,
              repo: job.repo,
              owner: job.owner,
              userId: job.userId,
              companyId,
              sourceFile: file.path,
              sourceSha: file.sha,
              mounted: !orphan,
            });
            console.log(`[backfill ${job._id}] ${file.path}: saved ${saved} doc(s)`);
            return { saved, usage, sha: file.sha, cached: false, failed: false };
          } catch (err) {
            // Surface the full failure — this used to log only err.message
            // and report saved:0 identically to "this file genuinely has no
            // endpoints", which made a real failure (e.g. a truncated
            // Claude response) indistinguishable from a legitimately empty
            // file. failed:true below makes that distinction explicit.
            console.error(`[backfill ${job._id}] FAILED to doc ${file.path}:`, err.stack || err.message);
            return {
              saved: 0,
              usage: { inputTokens: 0, outputTokens: 0 },
              sha: file.sha,
              cached: false,
              failed: true,
              failedPath: file.path,
              error: err.message,
            };
          }
        })
      );

      for (const r of results) {
        totalEndpoints += r.saved;
        totalIn += r.usage.inputTokens || 0;
        totalOut += r.usage.outputTokens || 0;
        processedShas.push(r.sha);
        if (r.cached) cachedCount += 1;
        if (r.failed) failedFiles.push({ path: r.failedPath, error: r.error || "unknown error" });
      }

      job.filesProcessed += batch.length;
      job.filesCached = cachedCount;
      job.filesFailed = failedFiles.length;
      job.failedFiles = failedFiles;
      job.endpointsDetected = totalEndpoints;
      job.tokensInput = totalIn;
      job.tokensOutput = totalOut;
      await job.save();
    }

    // 6) Zombie cleanup: drop backfill docs whose source file was removed.
    const removed = await cleanupZombieDocs({
      owner: job.owner,
      repo: job.repo,
      liveShas: processedShas,
    });
    job.zombieDocsRemoved = removed;

    job.status = "completed";
    job.finishedAt = new Date();
    await job.save();
  } catch (err) {
    console.error("Backfill failed:", err);
    job.status = "failed";
    job.error = err.message;
    job.finishedAt = new Date();
    await job.save();
  }
}

async function startBackfill(req, res) {
  console.log("==================================================");
  console.log("[startBackfill] HIT");
  console.log("[startBackfill] body:", req.body);
  console.log("==================================================");

  const { installationId, owner, repo, force } = req.body;

  if (!installationId || !owner || !repo) {
    console.log("[startBackfill] MISSING FIELDS — bailing");
    return res
      .status(400)
      .json({ message: "installationId, owner and repo are required" });
  }

  const installation = await Installation.findOne({
    installationId: Number(installationId),
  });
  console.log(
    "[startBackfill] installation lookup:",
    installation ? `found userId=${installation.userId} repos=${installation.repos?.length}` : "NOT FOUND"
  );

  if (!installation) {
    return res.status(404).json({ message: "Installation not found" });
  }

  // force=true wipes existing backfill docs for this repo so the SHA cache
  // (line ~250 below) doesn't short-circuit Claude and we get a clean
  // regeneration with the latest prompt / schema context.
  // DISABLED: deleting the docs orphaned everything hanging off them — saved
  // tests, per-endpoint variables, NEW/Edited labels — because those point at
  // the doc's _id. A forced run now skips the SHA cache instead (job.force) and
  // the save upserts each endpoint in place.
  // if (force) {
  //   const wiped = await Doc.deleteMany({ owner, repo, source: "backfill" });
  //   console.log(
  //     `[startBackfill] force=true — wiped ${wiped.deletedCount} existing backfill docs`
  //   );
  // }

  const job = await BackfillJob.create({
    installationId: Number(installationId),
    owner,
    repo,
    userId: installation.userId,
    force: force === true,
  });
  console.log("[startBackfill] job created:", job._id.toString());

  runBackfill(job._id).catch((err) =>
    console.error("[runBackfill] CRASHED:", err)
  );

  res.status(202).json({ jobId: job._id, status: job.status });
}

async function getBackfillJob(req, res) {
  const job = await BackfillJob.findById(req.params.jobId);
  if (!job) return res.status(404).json({ message: "Job not found" });
  res.status(200).json(job);
}

module.exports = {
  githubCallback,
  getConnectLink,
  startBackfill,
  getBackfillJob,
  // The watcher drives the same doc-regeneration pipeline the manual button
  // does — exported so it runs the identical code path instead of a copy that
  // can drift.
  runBackfill,
};
