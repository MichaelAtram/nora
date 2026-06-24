// @ts-nocheck
const express = require("express");
const db = require("../db");
const billing = require("../billing");

const router = express.Router();

router.get("/subscription", async (req, res, next) => {
  try {
    const sub = await billing.getSubscription(req.user.id);
    const [agentCount, backupUsage] = await Promise.all([
      db.query("SELECT COUNT(*) FROM agents WHERE user_id = $1", [req.user.id]),
      billing.getBackupUsage(req.user.id).catch(() => ({
        backup_storage_used_bytes: 0,
        backup_count_for_agent: 0,
      })),
    ]);
    res.json({
      ...sub,
      agents_used: parseInt(agentCount.rows[0].count, 10),
      backup_storage_used_bytes: backupUsage.backup_storage_used_bytes,
    });
  } catch (e) {
    next(e);
  }
});

router.post("/checkout", async (req, res, next) => {
  if (!billing.BILLING_ENABLED) return res.status(404).json({ error: "Billing is disabled" });
  try {
    const { plan } = req.body;
    if (!plan || !["pro", "enterprise"].includes(plan))
      return res.status(400).json({ error: "Invalid plan" });
    const result = await billing.createCheckoutSession(req.user.id, plan);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post("/portal", async (req, res, next) => {
  if (!billing.BILLING_ENABLED) return res.status(404).json({ error: "Billing is disabled" });
  try {
    const result = await billing.createPortalSession(req.user.id);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
