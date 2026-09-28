const express = require("express");
const router = express.Router();
const { requireAdminKey } = require("../middleware/adminKeyMiddleware");
const c = require("../controllers/adminController");

// Operator-only. Guarded by OLIVIA_ADMIN_KEY, never by a user session — see
// adminKeyMiddleware for why.
router.use(requireAdminKey);

// A cheap call the admin page uses to check the key before showing anything.
router.get("/ping", (req, res) => res.json({ ok: true }));

router.get("/companies", c.listCompanies);
router.get("/companies/:id/usage", c.companyUsage);
router.patch("/companies/:id", c.updateCompanyPlan);

// Fake spend, to watch a limit bite without paying for it.
router.post("/companies/:id/simulate-spend", c.simulateSpend);
router.delete("/companies/:id/simulate-spend", c.clearSimulatedSpend);

module.exports = router;
