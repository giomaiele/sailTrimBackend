const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const c = require("../controllers/qaReportController");

// Reports live on their own router (not inside apiQARoutes) because one of these
// routes is PUBLIC: keeping it next to `protect`-ed siblings is how an auth
// middleware gets added to the wrong group later.

// Signed in: read a report and manage its share links.
router.get("/repos/:owner/:repo", protect, c.getReport);
router.get("/repos/:owner/:repo/links", protect, c.listShareLinks);
router.post("/repos/:owner/:repo/links", protect, c.createShareLink);

router.get("/projects/:id", protect, c.getReport);
router.get("/projects/:id/links", protect, c.listShareLinks);
router.post("/projects/:id/links", protect, c.createShareLink);

// ?surface=mcp on these — the controller reads it, so one route pair serves
// both project kinds without a second path shape.
router.delete("/links/:token", protect, c.revokeShareLink);

// PUBLIC: the link the customer forwards. No session, no company header — the
// token alone decides what comes back.
router.get("/shared/:token", c.getSharedReport);

module.exports = router;
