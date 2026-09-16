const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const c = require("../controllers/mcpLabController.js");

// --- Connection / introspection ---
router.post("/connect", protect, c.connectServer);
router.post("/tools", protect, c.getTools);

// --- MCP projects ---
router.post("/projects", protect, c.saveProject);
router.get("/projects", protect, c.listProjects);
router.get("/projects/:id", protect, c.getProject);
router.delete("/projects/:id", protect, c.deleteMcpProject);
router.get("/projects/:id/tools", protect, c.listProjectTools);

// --- Playground / runs ---
router.post("/invoke", protect, c.invokeTool);
router.post("/run", protect, c.runPrompt);

// --- LLM-as-Judge ---
router.post("/judge/:traceId", protect, c.judge);
router.post("/compare/:traceId", protect, c.compare);

// --- Test case generator ---
router.post("/generate-cases", protect, c.generateCases);

// --- Generated MCP docs ---
router.post("/docs/generate", protect, c.generateDocs);
router.post("/projects/:id/tools/:toolName/docs", protect, c.generateDocsForTool);
router.get("/docs", protect, c.listDocs);
router.get("/docs/:id", protect, c.getDoc);
router.delete("/docs/:id", protect, c.deleteDoc);

// --- MCP QA agent ---
router.post("/qa/run", protect, c.runQa);
router.get("/qa/runs", protect, c.listQaRuns);
router.get("/qa/runs/:id", protect, c.getQaRun);
router.delete("/qa/runs/:id", protect, c.deleteQaRun);

// --- Smoke suite (per project) ---
router.get("/projects/:id/smoke", protect, c.getSmoke);
router.post("/projects/:id/smoke/generate", protect, c.generateSmoke);
router.post("/projects/:id/smoke/run", protect, c.runSmoke);
router.post(
  "/projects/:id/smoke/cases/:caseId/refine",
  protect,
  c.refineSmokeCase
);

// --- Regression suite (per project) ---
router.get("/projects/:id/regression", protect, c.getRegression);
router.post("/projects/:id/regression/generate", protect, c.generateRegression);
router.post("/projects/:id/regression/run", protect, c.runRegression);
router.post(
  "/projects/:id/regression/cases/:caseId/refine",
  protect,
  c.refineRegressionCase
);

// --- MCP bugs ---
router.get("/bugs", protect, c.listBugs);
router.patch("/bugs/:id/status", protect, c.updateBugStatus);
router.delete("/bugs/:id", protect, c.deleteBug);

// --- Traces ---
router.get("/traces", protect, c.listTraces);
router.get("/traces/:id", protect, c.getTrace);
router.delete("/traces/:id", protect, c.deleteTrace);

// --- Token cost profiler ---
router.post("/projects/:id/profile/run", protect, c.runProfile);
router.get("/profile/runs", protect, c.listProfileRuns);
router.get("/profile/runs/:id", protect, c.getProfileRun);
router.delete("/profile/runs/:id", protect, c.deleteProfileRun);

// --- Load / stress tester ("k6 for MCP") ---
router.post("/projects/:id/load/run", protect, c.runLoad);
router.get("/load/runs", protect, c.listLoadRuns);
router.get("/load/runs/:id", protect, c.getLoadRun);
router.delete("/load/runs/:id", protect, c.deleteLoadRun);

// --- Security scanner ---
router.post("/projects/:id/security/scan", protect, c.runSecurityScan);
router.get("/security/runs", protect, c.listSecurityRuns);
router.get("/security/runs/:id", protect, c.getSecurityRun);
router.delete("/security/runs/:id", protect, c.deleteSecurityRun);

// --- Suites ---
router.post("/suites", protect, c.createSuite);
router.get("/suites", protect, c.listSuites);
router.get("/suites/:id", protect, c.getSuite);
router.delete("/suites/:id", protect, c.deleteSuite);
router.post("/suites/:id/run", protect, c.runSuite);

// --- Per-tool saved suites (smoke / regression) ---
// One model call per tool, so a server with hundreds of tools works. The
// project-level smoke/regression routes above keep the old all-at-once
// behaviour for projects small enough that it still fits.
router.post("/projects/:projectId/tools/:toolName/suites", protect, c.generateToolSuite);
router.post("/projects/:id/tool-suites", protect, c.generateProjectToolSuites);
router.get("/projects/:id/tool-suites", protect, c.listToolSuites);
router.post("/tool-suites/:suiteId/run", protect, c.runToolSuite);
router.post("/tool-suites/:suiteId/cases/:caseId/refine", protect, c.refineToolSuiteCase);
// One test written by hand (blank, or from a sentence), and removing one.
router.post("/tool-suites/:suiteId/cases", protect, c.createToolSuiteCase);
router.delete("/tool-suites/:suiteId/cases/:caseId", protect, c.deleteToolSuiteCase);
router.delete("/tool-suites/:suiteId", protect, c.deleteToolSuite);

module.exports = router;
