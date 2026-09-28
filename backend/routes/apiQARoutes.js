const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { requireBudget } = require("../middleware/budgetMiddleware");
const {
  getConfig,
  upsertConfig,
  importProjectSpec,
  discoverGithubSpec,
  importGithubSpec,
  syncGithubSpec,
  listProjects,
  getProjectDocs,
  updateDocBody,
  deleteProject,
  setProjectAuth,
  getProjectSectionCollection,
  findBugs,
  findBugsForSection,
  getBugs,
  listScopeBugs,
  listScopeRuns,
  deleteBug,
  updateBugStatus,
  getCollection,
  listRuns,
  getRun,
  listSuiteRuns,
  getSuiteRun,
  generateSuite,
  generateSectionSuites,
  listSuites,
  runSuite,
  refineSuiteCase,
  createSuiteCase,
  deleteSuiteCase,
  deleteSuite,
  getDocVariables,
  setDocVariables,
} = require("../controllers/apiQAController");

router.get("/config/:owner/:repo", protect, getConfig);
router.put("/config/:owner/:repo", protect, upsertConfig);

// API Project (spec-import) flow
router.post("/projects/import", protect, importProjectSpec);
// GitHub-connected spec: discover the file, import it, and re-sync on demand
router.post("/projects/github/discover", protect, discoverGithubSpec);
router.post("/projects/github/import", protect, importGithubSpec);
router.post("/projects/:id/sync", protect, syncGithubSpec);
router.get("/projects", protect, listProjects);
router.get("/projects/:id/docs", protect, getProjectDocs);
router.put("/docs/:docId/body", protect, updateDocBody);
router.delete("/projects/:id", protect, deleteProject);
router.put("/projects/:id/auth", protect, setProjectAuth);
router.get("/projects/:id/section-collection", protect, getProjectSectionCollection);

router.post("/find-bugs/:docId", protect, requireBudget("api"), findBugs);
router.get("/bugs/:docId", protect, getBugs);
// Repo-wide / project-wide views: what the Bugs and QA Runs pages read.
router.get("/repos/:owner/:repo/bugs", protect, listScopeBugs);
router.get("/repos/:owner/:repo/runs", protect, listScopeRuns);
router.get("/projects/:id/bugs", protect, listScopeBugs);
router.get("/projects/:id/qa-runs", protect, listScopeRuns);
router.patch("/bugs/:id", protect, updateBugStatus);
router.delete("/bugs/:id", protect, deleteBug);

router.get("/collection/:docId", protect, getCollection);

router.get("/runs/:docId", protect, listRuns);
router.get("/run/:id", protect, getRun);

// Suite QA — section-level multi-endpoint runs
router.post("/projects/:id/suite/:section", protect, requireBudget("api"), findBugsForSection);
router.get("/projects/:id/suite-runs", protect, listSuiteRuns);
router.get("/suite-run/:id", protect, getSuiteRun);

// Saved test suites (smoke / regression) — generated per endpoint, kept, re-run
// later to catch behaviour that changed. Distinct from find-bugs above, which
// generates throwaway cases for a single hunt.
router.post("/docs/:docId/suites", protect, requireBudget("api"), generateSuite);
router.post("/projects/:id/sections/:section/suites", protect, requireBudget("api"), generateSectionSuites);
router.get("/projects/:id/suites", protect, listSuites);
// Same two, for endpoints that came from a connected GitHub repo instead of a
// pasted spec — those have owner/repo and no projectId.
router.post("/repos/:owner/:repo/sections/:section/suites", protect, requireBudget("api"), generateSectionSuites);
router.get("/repos/:owner/:repo/suites", protect, listSuites);
router.post("/suites/:suiteId/run", protect, requireBudget("api"), runSuite);
router.post("/suites/:suiteId/cases/:caseId/refine", protect, requireBudget("api"), refineSuiteCase);
// One test written by hand (blank, or from a sentence), and removing one.
router.post("/suites/:suiteId/cases", protect, requireBudget("api"), createSuiteCase);
router.delete("/suites/:suiteId/cases/:caseId", protect, deleteSuiteCase);
router.delete("/suites/:suiteId", protect, deleteSuite);

// Per-endpoint variables (tokens / api keys / ids a single test needs). GET
// also reports the global set and which keys this endpoint overrides.
router.get("/docs/:docId/variables", protect, getDocVariables);
router.put("/docs/:docId/variables", protect, setDocVariables);

module.exports = router;
