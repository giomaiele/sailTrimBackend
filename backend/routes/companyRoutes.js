const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const c = require("../controllers/companyController");

// Public: read invite metadata before signup/login
router.get("/invite/:token", c.getInvite);

// Authenticated
router.get("/", protect, c.getMyCompany);
router.get("/members", protect, c.listMembers);
router.post("/invite", protect, c.inviteMember);
router.post("/accept", protect, c.acceptInvite);
router.delete("/members/:userId", protect, c.removeMember);
router.delete("/invite/:id", protect, c.cancelInvite);

router.get("/slack", protect, c.getSlackConfig);
router.put("/slack", protect, c.saveSlackConfig);
router.delete("/slack", protect, c.deleteSlackConfig);

// The workspace's own Anthropic key: its work bills that account, not Olivia's.
router.get("/anthropic-key", protect, c.getCompanyAnthropicKey);
router.put("/anthropic-key", protect, c.saveCompanyAnthropicKey);
router.delete("/anthropic-key", protect, c.deleteCompanyAnthropicKey);

module.exports = router;
