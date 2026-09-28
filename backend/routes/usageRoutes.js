const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { getUsage } = require("../controllers/usageController");

// This month's AI spend for the signed-in workspace.
router.get("/", protect, getUsage);

module.exports = router;
