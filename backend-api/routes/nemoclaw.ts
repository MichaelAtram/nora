// @ts-nocheck
const express = require("express");
const db = require("../db");
const { isNemoClawSandbox } = require("../agentRuntimeFields");
const { runtimeUrlForAgent } = require("../../agent-runtime/lib/agentEndpoints");
const { runtimeAuthHeaders } = require("../runtimeAuth");

const router = express.Router();

router.get("/:id/nemoclaw/status", async (req, res, next) => {
  try {
    const agentResult = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const agent = agentResult.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (!isNemoClawSandbox(agent))
      return res.status(400).json({ error: "Agent is not a NemoClaw sandbox" });
    const runtimeUrl = runtimeUrlForAgent(agent, "/nemoclaw/status");
    if (!runtimeUrl || agent.status !== "running")
      return res.json({ status: agent.status, sandbox: null });

    const resp = await fetch(runtimeUrl, { headers: await runtimeAuthHeaders(agent) });
    if (!resp.ok) throw new Error(`Agent runtime returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    next(e);
  }
});

router.get("/:id/nemoclaw/policy", async (req, res, next) => {
  try {
    const agentResult = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const agent = agentResult.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (!isNemoClawSandbox(agent))
      return res.status(400).json({ error: "Agent is not a NemoClaw sandbox" });
    const runtimeUrl = runtimeUrlForAgent(agent, "/nemoclaw/policy");
    if (!runtimeUrl || agent.status !== "running")
      return res.status(400).json({ error: "Agent is not running" });

    const resp = await fetch(runtimeUrl, { headers: await runtimeAuthHeaders(agent) });
    if (!resp.ok) throw new Error(`Agent runtime returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    next(e);
  }
});

router.post("/:id/nemoclaw/policy", async (req, res, next) => {
  try {
    const agentResult = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const agent = agentResult.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (!isNemoClawSandbox(agent))
      return res.status(400).json({ error: "Agent is not a NemoClaw sandbox" });
    const runtimeUrl = runtimeUrlForAgent(agent, "/nemoclaw/policy");
    if (!runtimeUrl || agent.status !== "running")
      return res.status(400).json({ error: "Agent is not running" });

    const resp = await fetch(runtimeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await runtimeAuthHeaders(agent)) },
      body: JSON.stringify(req.body),
    });
    if (!resp.ok) throw new Error(`Agent runtime returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    next(e);
  }
});

router.get("/:id/nemoclaw/approvals", async (req, res, next) => {
  try {
    const agentResult = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const agent = agentResult.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (!isNemoClawSandbox(agent))
      return res.status(400).json({ error: "Agent is not a NemoClaw sandbox" });
    const runtimeUrl = runtimeUrlForAgent(agent, "/nemoclaw/approvals");
    if (!runtimeUrl || agent.status !== "running") return res.json({ approvals: [] });

    const resp = await fetch(runtimeUrl, { headers: await runtimeAuthHeaders(agent) });
    if (!resp.ok) throw new Error(`Agent runtime returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    next(e);
  }
});

router.post("/:id/nemoclaw/approvals/:rid", async (req, res, next) => {
  try {
    const agentResult = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.user.id,
    ]);
    const agent = agentResult.rows[0];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (!isNemoClawSandbox(agent))
      return res.status(400).json({ error: "Agent is not a NemoClaw sandbox" });
    const runtimeUrl = runtimeUrlForAgent(agent, `/nemoclaw/approvals/${req.params.rid}`);
    if (!runtimeUrl || agent.status !== "running")
      return res.status(400).json({ error: "Agent is not running" });

    const resp = await fetch(runtimeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await runtimeAuthHeaders(agent)) },
      body: JSON.stringify(req.body),
    });
    if (!resp.ok) throw new Error(`Agent runtime returned ${resp.status}`);
    res.json(await resp.json());
  } catch (e) {
    next(e);
  }
});

module.exports = router;
