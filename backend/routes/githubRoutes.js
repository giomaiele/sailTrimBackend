const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { requireBudget } = require("../middleware/budgetMiddleware");
const {
  githubCallback,
  getConnectLink,
  startBackfill,
  getBackfillJob,
} = require("../controllers/githubController");

router.get("/connect-link", protect, getConnectLink);
// /callback stays public: it's a plain browser redirect from GitHub, no
// bearer token available to send.
router.get("/callback", githubCallback);
// Re-documenting a repo is the single most expensive thing Olivia does.
router.post("/docs/backfill", protect, requireBudget("api"), startBackfill);
router.get("/docs/backfill/:jobId", protect, getBackfillJob);

module.exports = router;
