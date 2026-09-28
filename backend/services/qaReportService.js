const Doc = require("../model/DocModel");
const ApiSuite = require("../model/ApiSuiteModel");
const Bug = require("../model/BugModel");
const TestRun = require("../model/TestRunModel");
const McpProject = require("../model/McpProjectModel");
const McpTool = require("../model/McpToolModel");
const McpToolSuite = require("../model/McpToolSuiteModel.js");
const McpBug = require("../model/McpBugModel");
const McpQaRun = require("../model/McpQaRunModel");

// The QA report a customer sends to THEIR customer: how much of the surface is
// covered, what ran, and what's broken.
//
// Two different questions, deliberately answered differently:
//   - Coverage is a snapshot of NOW. "40% of endpoints had tests last Tuesday"
//     answers nothing anyone acts on.
//   - Activity (runs, bugs found) is counted over the chosen period, because
//     that's the "what did QA do this month" half of the report.
//
// Shared by the API and MCP sides so both reports have the same shape, and by
// the public share link — which is why nothing here reads req/user: the caller
// resolves the scope and passes ids.

function periodFilter(from, to) {
  const range = {};
  if (from) range.$gte = new Date(from);
  if (to) range.$lte = new Date(to);
  return Object.keys(range).length ? range : null;
}

function countBy(rows, field) {
  const out = {};
  for (const r of rows) {
    const k = r[field] || "unknown";
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

// Coverage counts a unit (endpoint or tool) as covered when it has at least one
// SAVED test. The bug hunter's throwaway cases don't count: they're run once and
// discarded, so they can't be what "this endpoint is covered" means.
function coverageOf({ units, suitesByUnit }) {
  let withTests = 0;
  let withSmoke = 0;
  let withRegression = 0;
  let cases = 0;
  const uncovered = [];

  for (const u of units) {
    const suites = suitesByUnit.get(u.key) || [];
    const n = suites.reduce((acc, s) => acc + (s.cases?.length || 0), 0);
    cases += n;
    if (n > 0) withTests += 1;
    else uncovered.push(u.label);
    if (suites.some((s) => s.kind === "smoke" && s.cases?.length)) withSmoke += 1;
    if (suites.some((s) => s.kind === "regression" && s.cases?.length)) {
      withRegression += 1;
    }
  }

  return {
    units: units.length,
    withTests,
    withSmoke,
    withRegression,
    percent: pct(withTests, units.length),
    testCases: cases,
    uncovered,
  };
}

// Results of the last saved run of each suite. Not summed over the period: a
// suite re-run ten times is still one answer to "does it pass today?".
function lastRunTotals(suites, range) {
  let passed = 0;
  let failed = 0;
  let regressions = 0;
  let suitesRun = 0;
  let lastAt = null;

  for (const s of suites) {
    const at = s.lastRun?.at ? new Date(s.lastRun.at) : null;
    if (!at) continue;
    if (range && ((range.$gte && at < range.$gte) || (range.$lte && at > range.$lte))) {
      continue;
    }
    suitesRun += 1;
    passed += s.lastRun.passed || 0;
    failed += s.lastRun.failed || 0;
    regressions += s.lastRun.regressions || 0;
    if (!lastAt || at > lastAt) lastAt = at;
  }

  const executed = passed + failed;
  return {
    suitesRun,
    executed,
    passed,
    failed,
    regressions,
    passRate: pct(passed, executed),
    lastAt,
  };
}

function bugTotals(bugs, range) {
  const inPeriod = range
    ? bugs.filter((b) => {
        const at = new Date(b.createdAt);
        if (range.$gte && at < range.$gte) return false;
        if (range.$lte && at > range.$lte) return false;
        return true;
      })
    : bugs;

  const open = bugs.filter((b) => b.status === "open");
  return {
    // Open/fixed/ignored describe the state NOW — a bug opened last month and
    // still broken belongs in this report.
    open: open.length,
    fixed: bugs.filter((b) => b.status === "fixed").length,
    ignored: bugs.filter((b) => b.status === "ignored").length,
    openBySeverity: countBy(open, "severity"),
    foundInPeriod: inPeriod.length,
  };
}

/** QA report for one connected repo, or one imported API project. */
async function apiReport({ companyId, owner, repo, projectId, from, to }) {
  const range = periodFilter(from, to);
  const docScope = projectId
    ? { projectId, companyId }
    : { owner, repo, companyId };

  const docs = await Doc.find(docScope).select("method path").lean();
  const docIds = docs.map((d) => d._id);

  const suites = await ApiSuite.find({
    companyId,
    docId: { $in: docIds },
  })
    .select("docId kind cases lastRun")
    .lean();

  const suitesByUnit = new Map();
  for (const s of suites) {
    const k = String(s.docId);
    if (!suitesByUnit.has(k)) suitesByUnit.set(k, []);
    suitesByUnit.get(k).push(s);
  }

  const bugs = await Bug.find({ companyId, docId: { $in: docIds } })
    .select("status severity createdAt")
    .lean();

  const runFilter = { companyId, docId: { $in: docIds } };
  if (range) runFilter.createdAt = range;
  const runs = await TestRun.find(runFilter).select("totalTests bugCount createdAt").lean();

  return {
    kind: "api",
    subject: projectId ? "API project" : `${owner}/${repo}`,
    owner: owner || "",
    repo: repo || "",
    projectId: projectId ? String(projectId) : "",
    period: { from: from || null, to: to || null },
    generatedAt: new Date(),
    unitLabel: "endpoints",
    coverage: coverageOf({
      units: docs.map((d) => ({
        key: String(d._id),
        label: `${d.method} ${d.path}`,
      })),
      suitesByUnit,
    }),
    tests: lastRunTotals(suites, range),
    bugs: bugTotals(bugs, range),
    bugHunter: {
      runs: runs.length,
      testsRun: runs.reduce((n, r) => n + (r.totalTests || 0), 0),
      bugsFound: runs.reduce((n, r) => n + (r.bugCount || 0), 0),
    },
  };
}

/** The same report for one MCP project. */
async function mcpReport({ companyId, projectId, from, to }) {
  const range = periodFilter(from, to);
  const project = await McpProject.findOne({ _id: projectId, companyId })
    .select("projectName")
    .lean();
  if (!project) {
    const err = new Error("MCP project not found");
    err.statusCode = 404;
    throw err;
  }

  const tools = await McpTool.find({ projectId, companyId }).select("name").lean();
  const suites = await McpToolSuite.find({ projectId, companyId })
    .select("toolName kind cases lastRun")
    .lean();

  const suitesByUnit = new Map();
  for (const s of suites) {
    if (!suitesByUnit.has(s.toolName)) suitesByUnit.set(s.toolName, []);
    suitesByUnit.get(s.toolName).push(s);
  }

  const bugs = await McpBug.find({ companyId, projectId })
    .select("status severity createdAt")
    .lean();

  const runFilter = { companyId, projectId };
  if (range) runFilter.createdAt = range;
  const runs = await McpQaRun.find(runFilter).select("summary createdAt").lean();

  return {
    kind: "mcp",
    subject: project.projectName || "MCP project",
    projectId: String(projectId),
    period: { from: from || null, to: to || null },
    generatedAt: new Date(),
    unitLabel: "tools",
    coverage: coverageOf({
      units: tools.map((t) => ({ key: t.name, label: t.name })),
      suitesByUnit,
    }),
    tests: lastRunTotals(suites, range),
    bugs: bugTotals(bugs, range),
    bugHunter: {
      runs: runs.length,
      testsRun: runs.reduce((n, r) => n + (r.summary?.total || 0), 0),
      bugsFound: runs.reduce((n, r) => n + (r.summary?.bugs || 0), 0),
    },
  };
}

module.exports = { apiReport, mcpReport };
