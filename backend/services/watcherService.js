const Doc = require("../model/DocModel");
const ApiWatcher = require("../model/ApiWatcherModel");
const WatcherRun = require("../model/WatcherRunModel");
const BackfillJob = require("../model/BackfillJob");
const apiSuiteService = require("./apiSuiteService");
const apiQAService = require("./apiQAService");
const prDiff = require("./prDiffService");
const usageLimit = require("./usageLimitService");
const aiUsage = require("./aiUsageService");
const { getUserAnthropicClient } = require("./userKeyService");

// The watcher agent.
//
// Something lands on the watched branch -> regenerate the repo's docs -> work
// out which endpoints are NEW -> flag them and generate QA for them. The point
// is that an endpoint shipped on Friday is documented and covered by Monday
// without anyone remembering to press a button.
//
// Doc regeneration reuses runBackfill, the exact pipeline the manual button
// drives. Required lazily because githubController requires this file's
// siblings — importing it at module load closes a cycle.
function backfillRunner() {
  return require("../controllers/githubController").runBackfill;
}

// Identity of an endpoint across regenerations. A doc's _id changes if it is
// deleted and recreated, so "new" is decided on method+path, which is what a
// human means by "a new endpoint appeared".
function endpointKey(doc) {
  return `${String(doc.method || "").toUpperCase()} ${doc.path}`;
}

/**
 * Compare the repo's endpoints against a snapshot and flag whatever is new.
 *
 * Split out of runWatcher so the comparison can be exercised on its own: the
 * snapshot is taken before regeneration and the diff after, which makes the
 * whole thing awkward to test as one block.
 */
// The parts of an endpoint that are its CONTRACT: parameter names, types and
// whether they're required, plus which response codes exist.
//
// Deliberately excludes descriptions and examples. Docs are written by a model,
// so their prose varies between regenerations even when the code didn't change;
// comparing it would mark untouched endpoints as edited. Names, types, required
// and status codes come from the code, so they only move when the code does.
// The type as a base kind, not the literal text. When one file changes, the
// backfill regenerates EVERY endpoint in it with the model, and the model
// writes the same type differently from one run to the next — "array",
// "Array<Object>", "object[]". Comparing that text flagged untouched endpoints
// as edited (a whole single-file API lit up on every merge). A real type change
// — string to number — still moves the base kind, so it's still caught.
function baseType(raw) {
  const t = String(raw || "").toLowerCase().trim();
  if (!t) return "";
  if (t.startsWith("array") || t.startsWith("list") || t.endsWith("[]")) return "array";
  if (/^(object|dict|map|record)/.test(t)) return "object";
  if (/^(int|integer|number|float|double|decimal|long)/.test(t)) return "number";
  if (/^(bool|boolean)/.test(t)) return "boolean";
  if (/^(str|string|text|uuid|date|datetime|email)/.test(t)) return "string";
  return t;
}

function paramSig(list) {
  return (list || [])
    .map((p) => `${p.name}:${baseType(p.type)}:${p.required ? 1 : 0}`)
    .sort();
}

function contractOf(doc) {
  return {
    body: paramSig(doc.requestBody),
    query: paramSig(doc.queryParams),
    responses: (doc.responses || [])
      .map((r) => Number(r.status))
      .filter(Boolean)
      .sort((a, b) => a - b),
  };
}

// A short human description of what moved, for the run history.
function describeContractChange(before, after) {
  const out = [];
  const diffParams = (label, a, b) => {
    const prev = new Map(a.map((sig) => [sig.split(":")[0], sig]));
    const next = new Map(b.map((sig) => [sig.split(":")[0], sig]));
    for (const name of next.keys()) if (!prev.has(name)) out.push(`added ${label} "${name}"`);
    for (const name of prev.keys()) if (!next.has(name)) out.push(`removed ${label} "${name}"`);
    for (const [name, sig] of next) {
      if (prev.has(name) && prev.get(name) !== sig) out.push(`changed ${label} "${name}"`);
    }
  };
  diffParams("body param", before.body, after.body);
  diffParams("query param", before.query, after.query);
  const prevCodes = new Set(before.responses);
  const nextCodes = new Set(after.responses);
  for (const code of nextCodes) if (!prevCodes.has(code)) out.push(`added response ${code}`);
  for (const code of prevCodes) if (!nextCodes.has(code)) out.push(`removed response ${code}`);
  return out;
}

/**
 * Find endpoints that existed before the merge and still exist, but whose
 * contract changed — and stamp them with when and in which PR.
 *
 * The doc content was already rewritten by the backfill; this only records that
 * it happened, which is what lets the UI say "Edited · last at <date>".
 */
async function diffAndFlagEditedEndpoints({
  scope,
  beforeContracts,
  prNumber = null,
  editedAt = new Date(),
  // false = only compute. The watcher decides afterwards whether the contract
  // result is trusted (see step 3c) and stamps the final list itself.
  write = true,
}) {
  const after = await Doc.find(scope)
    .select("method path requestBody queryParams responses")
    .lean();

  const edited = [];
  for (const d of after) {
    const prev = beforeContracts.get(endpointKey(d));
    if (!prev) continue; // new endpoint — reported by the new-endpoint diff
    const now = contractOf(d);
    if (JSON.stringify(prev) === JSON.stringify(now)) continue;
    edited.push({
      docId: d._id,
      method: d.method,
      path: d.path,
      changes: describeContractChange(prev, now),
    });
  }

  if (write && edited.length) {
    await Doc.updateMany(
      { _id: { $in: edited.map((e) => e.docId) } },
      { $set: { lastEditedAt: editedAt, lastEditedPr: prNumber } }
    );
  }
  return edited;
}

async function diffAndFlagNewEndpoints({ scope, beforeKeys, prNumber = null }) {
  const after = await Doc.find(scope).select("method path").lean();
  const fresh = after.filter((d) => !beforeKeys.has(endpointKey(d)));

  if (fresh.length) {
    await Doc.updateMany(
      { _id: { $in: fresh.map((d) => d._id) } },
      {
        $set: {
          isNewEndpoint: true,
          firstSeenAt: new Date(),
          firstSeenPr: prNumber,
        },
      }
    );
  }
  return { after, fresh };
}

/**
 * Run one watcher end to end.
 *
 * Never throws: a watcher fires from a webhook, where nothing is listening for
 * an exception and a crash would leave the run row stuck at "running". Failures
 * are recorded on the run instead.
 */
async function runPendingRun(runId) {
  // Claim the row atomically: two instances draining the same backlog, or a
  // GitHub retry arriving while the first attempt is live, must not both start
  // the same regeneration. Whoever flips it out of pending owns it.
  const run = await WatcherRun.findOneAndUpdate(
    { _id: runId, status: { $in: ["pending", "running"] } },
    { $set: { status: "running", startedAt: new Date() }, $inc: { attempts: 1 } },
    { new: true }
  );
  if (!run) return null; // already claimed or already finished

  const watcher = await ApiWatcher.findById(run.watcherId);
  if (!watcher) {
    run.status = "failed";
    run.error = "The watcher was deleted before this run started.";
    run.finishedAt = new Date();
    await run.save();
    return run;
  }

  // No request behind a watcher, so it opens its own usage context — otherwise
  // everything a merge triggers is recorded as belonging to nobody.
  return aiUsage.runWith(
    {
      companyId: watcher.companyId,
      userId: watcher.userId,
      surface: "api",
      owner: watcher.owner,
      repo: watcher.repo,
    },
    () => runClaimed(run, watcher)
  );
}

async function runClaimed(run, watcher) {
  // Budget gate, before any model call. A watcher fires on its own, so this is
  // where an over-budget workspace has to stop — nobody is watching a webhook.
  if (!(await usageLimit.withinBudget(watcher.companyId, "api"))) {
    run.status = "failed";
    run.error =
      "Skipped: this workspace has no API budget left, or its plan doesn't " +
      "include the API side.";
    run.finishedAt = new Date();
    await run.save();
    watcher.lastRun = { at: new Date(), status: "failed", newEndpoints: 0, testsCreated: 0 };
    await watcher.save().catch(() => {});
    return run;
  }

  const trigger = run.trigger || { kind: "manual" };

  watcher.lastRun = {
    at: new Date(),
    status: "running",
    newEndpoints: 0,
    testsCreated: 0,
  };
  await watcher.save();

  try {
    const scope = {
      owner: watcher.owner,
      repo: watcher.repo,
      companyId: watcher.companyId,
    };

    // 1) Snapshot what exists BEFORE regenerating. Taken as a set of
    // method+path so a doc that is rewritten in place doesn't read as new, plus
    // each endpoint's contract so a changed param can be told apart from an
    // untouched endpoint once the backfill has rewritten the docs.
    const before = await Doc.find(scope)
      .select("method path requestBody queryParams responses")
      .lean();
    const beforeKeys = new Set(before.map(endpointKey));
    const beforeContracts = new Map(before.map((d) => [endpointKey(d), contractOf(d)]));

    // 2) Regenerate the docs through the same job the manual button uses, so
    // the two can't drift.
    if (watcher.actions?.regenerateDocs !== false) {
      const job = await BackfillJob.create({
        installationId: watcher.installationId,
        owner: watcher.owner,
        repo: watcher.repo,
        userId: watcher.userId,
        status: "pending",
      });
      await backfillRunner()(job._id);

      const finished = await BackfillJob.findById(job._id).lean();
      if (finished?.status === "failed") {
        throw new Error(
          `Doc regeneration failed: ${finished.error || "unknown error"}`
        );
      }
    }

    // 3) Diff. Anything present now that wasn't in the snapshot is new.
    const { after, fresh } = await diffAndFlagNewEndpoints({
      scope,
      beforeKeys,
      prNumber: trigger.prNumber || null,
    });

    // 3b) Edited: same endpoint, different contract.
    const editedAt = trigger.mergedAt ? new Date(trigger.mergedAt) : new Date();
    // Computed, not stamped yet: the docs are rewritten by the model on every
    // merge, so a contract can "change" only because the doc was worded
    // differently (a 401 noted this time and not last time). Step 3c decides.
    const contractEdited = await diffAndFlagEditedEndpoints({
      scope,
      beforeContracts,
      prNumber: trigger.prNumber || null,
      editedAt,
      write: false,
    });
    let edited = contractEdited;

    const anthropicClient = watcher.userId
      ? await getUserAnthropicClient(watcher.userId).catch(() => null)
      : null;

    // 3c) Touched by the diff. The PR diff is the only thing that knows what
    // the code actually changed, so when it was read in full it DECIDES: only
    // endpoints it touched are labeled, and the contract comparison can't add
    // doc-wording noise on top. The contract result is the fallback when the
    // diff couldn't be read (no PR, API failure, or a diff too big to send
    // whole) — then nothing real is lost to a partial read.
    if (trigger.kind === "merge" && trigger.prNumber) {
      try {
        const files = await prDiff.fetchPRFiles({
          installationId: watcher.installationId,
          owner: watcher.owner,
          repo: watcher.repo,
          prNumber: trigger.prNumber,
        });
        const freshKeys = new Set(fresh.map(endpointKey));
        const items = after.map(endpointKey).filter((k) => !freshKeys.has(k));
        const { touched, analyzed, truncated } = await prDiff.findTouched({
          files,
          items,
          kind: "api",
          anthropicClient,
        });
        if (analyzed && !truncated) {
          // Keep the contract detail for endpoints the diff also named — it's
          // the precise "added param x" line — and drop the rest.
          const touchedKeys = new Set(touched.map((t) => t.key));
          edited = contractEdited.filter((e) =>
            touchedKeys.has(`${String(e.method).toUpperCase()} ${e.path}`)
          );
        }

        const byKey = new Map(
          edited.map((e) => [`${String(e.method).toUpperCase()} ${e.path}`, e])
        );
        for (const t of touched) {
          const existing = byKey.get(t.key);
          if (existing) {
            if (t.summary && !existing.changes.includes(t.summary)) {
              existing.changes.push(t.summary);
            }
            continue;
          }
          const doc = after.find((d) => endpointKey(d) === t.key);
          if (!doc) continue;
          const entry = {
            docId: doc._id,
            method: doc.method,
            path: doc.path,
            changes: [t.summary || "changed in this PR"],
          };
          edited.push(entry);
          byKey.set(t.key, entry);
        }
      } catch (err) {
        // Diff analysis is best-effort — the contract result above still stands.
        console.error("[watcher] PR diff analysis failed:", err.message);
      }
    }
    // Stamp whatever survived. Covers the fallback paths too (manual run, diff
    // unreadable), which never reached the update inside the block above.
    if (edited.length) {
      await Doc.updateMany(
        { _id: { $in: edited.map((e) => e.docId) } },
        { $set: { lastEditedAt: editedAt, lastEditedPr: trigger.prNumber || null } }
      );
    }

    // 4) Generate QA for the new endpoints only. One at a time, and a failure
    // on one endpoint is recorded rather than allowed to sink the run — the
    // other endpoints are still flagged and still worth reporting.

    let testsCreated = 0;
    let testsPassed = 0;
    let testsFailed = 0;
    let bugsFound = 0;
    const rows = [];
    for (const d of fresh) {
      const row = {
        docId: d._id,
        method: d.method,
        path: d.path,
        testsCreated: 0,
        testError: "",
      };
      if (watcher.actions?.generateTests !== false) {
        const suites = [];
        try {
          for (const kind of ["smoke", "regression"]) {
            const suite = await apiSuiteService.generateSuite({
              docId: d._id,
              kind,
              userId: watcher.userId,
              companyId: watcher.companyId,
              anthropicClient,
            });
            suites.push(suite);
            row.testsCreated += suite.cases.length;
          }
          testsCreated += row.testsCreated;
        } catch (err) {
          console.error(
            `[watcher] tests failed for ${d.method} ${d.path}:`,
            err.message
          );
          row.testError = err.message;
        }

        // Execute the SAVED suites, so the morning after a merge you know
        // whether the new endpoint works, not only that it exists. Reported
        // separately from generation: a project with no baseUrl or auth can't
        // run anything, and that must not look like the tests failed to be
        // written.
        if (watcher.actions?.runTests === true && suites.length) {
          for (const suite of suites) {
            try {
              const res = await apiSuiteService.runSuite({
                suiteId: suite._id,
                companyId: watcher.companyId,
                anthropicClient,
              });
              row.testsPassed += res.summary.passed;
              row.testsFailed += res.summary.failed;
              testsPassed += res.summary.passed;
              testsFailed += res.summary.failed;
            } catch (err) {
              console.error(
                `[watcher] run failed for ${d.method} ${d.path}:`,
                err.message
              );
              row.runError = err.message;
            }
          }
        }
      }

      // The bug hunter. Deliberately separate from the suites above: those are
      // saved checks that must keep passing, this generates throwaway cases and
      // reports what is actually WRONG with the endpoint that just shipped.
      // Conflating the two was the gap — an endpoint could arrive with a full
      // suite written for it and nobody had looked for bugs in it.
      if (watcher.actions?.runQa !== false) {
        try {
          const qa = await apiQAService.findBugs({
            docId: d._id,
            userId: watcher.userId,
            companyId: watcher.companyId,
            anthropicClient,
          });
          row.bugsFound = qa.bugCount || 0;
          row.qaRunId = String(qa.testRunId || qa.runId || "");
          bugsFound += row.bugsFound;
        } catch (err) {
          // Usually "no base URL set" — real, but not a reason to lose the rest
          // of the run's findings.
          console.error(
            `[watcher] QA failed for ${d.method} ${d.path}:`,
            err.message
          );
          row.qaError = err.message;
        }
      }
      rows.push(row);
    }

    run.newEndpoints = rows;
    run.editedEndpoints = edited;
    run.docsBefore = before.length;
    run.docsAfter = after.length;
    run.status = "success";
    run.finishedAt = new Date();
    await run.save();

    watcher.lastRun = {
      at: new Date(),
      status: "success",
      newEndpoints: fresh.length,
      testsCreated,
      testsPassed,
      testsFailed,
      bugsFound,
    };
    await watcher.save();

    console.log(
      `[watcher] ${watcher.owner}/${watcher.repo}: ${fresh.length} new endpoint(s), ${testsCreated} test(s)` +
        (watcher.actions?.runTests ? `, ${testsPassed} passed / ${testsFailed} failed` : "") +
        (watcher.actions?.runQa !== false ? `, ${bugsFound} bug(s)` : "")
    );
    return run;
  } catch (err) {
    console.error(`[watcher] run failed for ${watcher.owner}/${watcher.repo}:`, err);
    run.status = "failed";
    run.error = err.message || String(err);
    run.finishedAt = new Date();
    await run.save().catch(() => {});
    watcher.lastRun = {
      at: new Date(),
      status: "failed",
      newEndpoints: 0,
      testsCreated: 0,
    };
    await watcher.save().catch(() => {});
    return run;
  }
}

/**
 * Fire every watcher that cares about a merge. Called from the webhook, which
 * must answer GitHub immediately — a full regeneration takes minutes, so the
 * runs are started and deliberately NOT awaited.
 */
/**
 * Record a trigger as a pending run and start working on it.
 *
 * The row is written BEFORE the work begins and awaited, so the trigger is
 * durable: if the process dies mid-run — a deploy, a crash, a dyno restart —
 * the row is still there and drainPendingRuns() picks it up on the next boot.
 * The previous version started the work in memory and returned, which meant a
 * merge landing during a deploy was silently lost.
 */
async function enqueueRun({ watcher, trigger }) {
  const run = await WatcherRun.create({
    watcherId: watcher._id,
    owner: watcher.owner,
    repo: watcher.repo,
    trigger: { ...trigger, branch: trigger.branch || watcher.branch },
    status: "pending",
    userId: watcher.userId,
    companyId: watcher.companyId,
  });
  // Not awaited on purpose — the webhook has to answer GitHub now. Losing this
  // is survivable precisely because the row above is already committed.
  runPendingRun(run._id).catch((err) =>
    console.error("[watcher] run failed:", err.message)
  );
  return run;
}

/**
 * Pick up runs that were recorded but never finished — the ones orphaned by a
 * restart. Called once at boot.
 */
async function drainPendingRuns() {
  // "running" rows are included: a row left in that state means the process
  // that owned it is gone, since a live run always reaches success or failed.
  const orphans = await WatcherRun.find({
    status: { $in: ["pending", "running"] },
    attempts: { $lt: 3 },
  })
    .sort({ createdAt: 1 })
    .limit(20);

  if (orphans.length) {
    console.log(`[watcher] resuming ${orphans.length} interrupted run(s)`);
  }
  for (const run of orphans) {
    await runPendingRun(run._id).catch((err) =>
      console.error("[watcher] resume failed:", err.message)
    );
  }
  return orphans.length;
}

async function onBranchUpdated({ owner, repo, branch, trigger }) {
  const watchers = await ApiWatcher.find({ owner, repo, branch, enabled: true });
  if (!watchers.length) return 0;

  // Re-check the plan at FIRING time, not just at creation. A workspace that
  // downgrades keeps its watcher rows, and without this they would quietly go
  // on consuming model calls for a plan the company no longer pays for.
  const Company = require("../model/companyModel");
  const paid = new Set(
    (
      await Company.find({
        _id: { $in: watchers.map((w) => w.companyId) },
        plan: "pro",
      }).select("_id").lean()
    ).map((c) => String(c._id))
  );

  const allowed = watchers.filter((w) => paid.has(String(w.companyId)));
  if (!allowed.length) return 0;

  for (const w of allowed) {
    await enqueueRun({ watcher: w, trigger });
  }
  return allowed.length;
}

/**
 * Record a run and execute it now. Used by "run this watcher" callers that want
 * the work to start immediately; the durability comes from enqueueRun writing
 * the row first either way.
 */
async function runWatcher({ watcherId, trigger = { kind: "manual" } }) {
  const watcher = await ApiWatcher.findById(watcherId);
  if (!watcher) return null;
  const run = await WatcherRun.create({
    watcherId: watcher._id,
    owner: watcher.owner,
    repo: watcher.repo,
    trigger: { ...trigger, branch: trigger.branch || watcher.branch },
    status: "pending",
    userId: watcher.userId,
    companyId: watcher.companyId,
  });
  return runPendingRun(run._id);
}

module.exports = {
  runWatcher,
  runPendingRun,
  enqueueRun,
  drainPendingRuns,
  onBranchUpdated,
  endpointKey,
  diffAndFlagNewEndpoints,
  diffAndFlagEditedEndpoints,
  contractOf,
};
