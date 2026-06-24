// @ts-nocheck
// Per-agent LLM spend budgets with hard-cap enforcement. Mirrors
// workspaceBudgets.ts for CRUD/alert-dedup semantics, and adds the part only
// a provisioning control plane can do: when spend crosses 100% of a budget,
// the runtime is stopped (status 'stopped' + paused_reason 'budget_exceeded').
//
// Enforcement runs from two directions:
//   - inline, fire-and-forget after every recordTokenUsage in gatewayProxy;
//   - sweepAgentBudgets on a 60s interval (covers usage recorded outside the
//     gateway path, failed stops, and manual restarts while still over cap —
//     the status reconciler flips stopped->running whenever the container is
//     live, so re-enforcement is what makes the pause stick).
//
// Alert events (agent.budget_soft_exceeded / agent.budget_exceeded) are
// deduped per bucket via last_alerted_pct, exactly like workspace budgets.
// Enforcement itself is NOT deduped: while over the hard cap and running,
// every check re-pauses.

const db = require("./db");
const metrics = require("./metrics");
const containerManager = require("./containerManager");
const monitoring = require("./monitoring");

const VALID_PERIODS = new Set(["daily", "weekly", "monthly"]);
const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30 };
const PAUSED_REASON_BUDGET = "budget_exceeded";

function normalizePeriod(value) {
  const period = String(value || "monthly").trim();
  if (!VALID_PERIODS.has(period)) {
    const error = new Error(`period must be one of: ${[...VALID_PERIODS].join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  return period;
}

function normalizeLimit(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    const error = new Error("limit_usd must be a positive number");
    error.statusCode = 400;
    throw error;
  }
  return Math.round(num * 100) / 100;
}

function normalizeThreshold(value) {
  if (value == null) return 80;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 100) {
    const error = new Error("soft_threshold_pct must be between 0 and 100");
    error.statusCode = 400;
    throw error;
  }
  return Math.round(num);
}

function serializeBudget(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    period: row.period,
    limitUsd: Number(row.limit_usd),
    softThresholdPct: row.soft_threshold_pct,
    lastAlertedAt: row.last_alerted_at,
    lastAlertedPct: row.last_alerted_pct,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listBudgets(agentId, { dbClient = db } = {}) {
  const result = await dbClient.query(
    `SELECT id, agent_id, period, limit_usd, soft_threshold_pct,
            last_alerted_at, last_alerted_pct, created_at, updated_at
       FROM agent_budgets
      WHERE agent_id = $1
      ORDER BY period`,
    [agentId],
  );
  return result.rows.map(serializeBudget);
}

async function upsertBudget(agentId, payload = {}, { dbClient = db } = {}) {
  const period = normalizePeriod(payload.period);
  const limitUsd = normalizeLimit(payload.limitUsd ?? payload.limit_usd);
  const softThresholdPct = normalizeThreshold(
    payload.softThresholdPct ?? payload.soft_threshold_pct,
  );

  const result = await dbClient.query(
    `INSERT INTO agent_budgets (agent_id, period, limit_usd, soft_threshold_pct)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id, period) DO UPDATE
       SET limit_usd = EXCLUDED.limit_usd,
           soft_threshold_pct = EXCLUDED.soft_threshold_pct,
           updated_at = NOW()
     RETURNING id, agent_id, period, limit_usd, soft_threshold_pct,
               last_alerted_at, last_alerted_pct, created_at, updated_at`,
    [agentId, period, limitUsd, softThresholdPct],
  );
  return serializeBudget(result.rows[0]);
}

async function deleteBudget(budgetId, agentId, { dbClient = db } = {}) {
  const result = await dbClient.query(
    "DELETE FROM agent_budgets WHERE id = $1 AND agent_id = $2 RETURNING id",
    [budgetId, agentId],
  );
  return Boolean(result.rows[0]);
}

async function recordBudgetAlert(budgetId, pct, { dbClient = db } = {}) {
  await dbClient
    .query(
      `UPDATE agent_budgets
          SET last_alerted_at = NOW(),
              last_alerted_pct = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [budgetId, pct],
    )
    .catch((err) => console.error("Failed to record agent budget alert:", err.message));
}

function bucketFor(pct, softThresholdPct) {
  if (pct >= 100) return "hard";
  if (pct >= softThresholdPct) return "soft";
  return "none";
}

// Attach current spend + crossing bucket to each budget. Pure read; used by
// the budget API so the UI can render cap-vs-spend without extra calls.
async function listBudgetsWithSpend(agentId, deps = {}) {
  const { costResolver = metrics.getAgentCost } = deps;
  const budgets = await listBudgets(agentId, deps);
  const out = [];
  for (const budget of budgets) {
    const cost = await costResolver(agentId, { periodDays: PERIOD_DAYS[budget.period] });
    const currentUsd = Number(cost?.total_cost || 0);
    const pct = budget.limitUsd > 0 ? Math.floor((currentUsd / budget.limitUsd) * 100) : 0;
    out.push({ ...budget, currentUsd, pct, bucket: bucketFor(pct, budget.softThresholdPct) });
  }
  return out;
}

// Evaluate budgets for an agent and enforce the hard cap. Alerts are deduped
// per bucket (like workspace budgets); the stop action re-fires on every
// check while the agent is over cap and its runtime is up.
async function checkAndEnforce(agent, deps = {}) {
  const {
    dbClient = db,
    costResolver = metrics.getAgentCost,
    logEvent = (type, message, metadata) => monitoring.logEvent(type, message, metadata),
  } = deps;

  if (!agent?.id) return { enforced: false, crossings: [] };

  const budgets = await listBudgets(agent.id, { dbClient });
  if (budgets.length === 0) return { enforced: false, crossings: [] };

  const crossings = [];
  let enforced = false;

  for (const budget of budgets) {
    const cost = await costResolver(agent.id, { periodDays: PERIOD_DAYS[budget.period] });
    const currentUsd = Number(cost?.total_cost || 0);
    const pct = budget.limitUsd > 0 ? Math.floor((currentUsd / budget.limitUsd) * 100) : 0;
    const bucket = bucketFor(pct, budget.softThresholdPct);
    if (bucket === "none") continue;
    crossings.push({ budget, bucket, currentUsd, pct });

    const lastBucket =
      budget.lastAlertedPct == null
        ? "none"
        : budget.lastAlertedPct >= 100
          ? "hard"
          : budget.lastAlertedPct >= budget.softThresholdPct
            ? "soft"
            : "none";
    const shouldAlert = bucket === "hard" ? lastBucket !== "hard" : lastBucket === "none";

    if (shouldAlert) {
      const type = bucket === "hard" ? "agent.budget_exceeded" : "agent.budget_soft_exceeded";
      const message =
        bucket === "hard"
          ? `Agent "${agent.name || agent.id}" exceeded its ${budget.period} budget ($${currentUsd.toFixed(2)} of $${budget.limitUsd.toFixed(2)})`
          : `Agent "${agent.name || agent.id}" reached ${pct}% of its ${budget.period} budget ($${currentUsd.toFixed(2)} of $${budget.limitUsd.toFixed(2)})`;
      await Promise.resolve(
        logEvent(type, message, {
          agentId: agent.id,
          budgetId: budget.id,
          period: budget.period,
          limitUsd: budget.limitUsd,
          currentUsd,
          pct,
        }),
      ).catch(() => {});
      await recordBudgetAlert(budget.id, pct, { dbClient });
    }

    if (bucket === "hard" && !enforced) {
      enforced = await enforcePause(agent, { budget, currentUsd, pct }, deps);
    }
  }

  return { enforced, crossings };
}

// Pause the runtime for a hard crossing. paused_reason is written first so
// the intent survives a failed stop; status only flips once the stop call
// succeeded. A failed stop is retried by the next sweep.
async function enforcePause(agent, crossing, deps = {}) {
  const {
    dbClient = db,
    stopRuntime = (target) => containerManager.stop(target),
    logEvent = (type, message, metadata) => monitoring.logEvent(type, message, metadata),
  } = deps;

  if (!["running", "warning"].includes(agent.status)) return false;

  await dbClient.query("UPDATE agents SET paused_reason = $1 WHERE id = $2", [
    PAUSED_REASON_BUDGET,
    agent.id,
  ]);

  try {
    await stopRuntime(agent);
  } catch (err) {
    await Promise.resolve(
      logEvent(
        "agent.budget_pause_failed",
        `Failed to stop agent "${agent.name || agent.id}" after budget hard cap: ${err.message}`,
        { agentId: agent.id, budgetId: crossing.budget.id, error: err.message },
      ),
    ).catch(() => {});
    return false;
  }

  await dbClient.query("UPDATE agents SET status = 'stopped' WHERE id = $1", [agent.id]);
  await Promise.resolve(
    logEvent(
      "agent.budget_paused",
      `Agent "${agent.name || agent.id}" was paused: ${crossing.budget.period} budget hard cap reached ($${crossing.currentUsd.toFixed(2)} of $${crossing.budget.limitUsd.toFixed(2)})`,
      {
        agentId: agent.id,
        budgetId: crossing.budget.id,
        period: crossing.budget.period,
        limitUsd: crossing.budget.limitUsd,
        currentUsd: crossing.currentUsd,
        pct: crossing.pct,
      },
    ),
  ).catch(() => {});
  return true;
}

// Clear the budget pause marker (called when an operator manually starts the
// agent — restarting is an explicit override; the sweep re-pauses on the next
// cycle if the agent is still over its cap and the cap wasn't raised).
async function clearPausedReason(agentId, { dbClient = db } = {}) {
  await dbClient
    .query("UPDATE agents SET paused_reason = NULL WHERE id = $1 AND paused_reason IS NOT NULL", [
      agentId,
    ])
    .catch(() => {});
}

// Periodic re-enforcement over every agent that has a budget and a live-ish
// runtime. Best-effort by design, like the other background tasks.
async function sweepAgentBudgets(deps = {}) {
  const { dbClient = db } = deps;
  try {
    const result = await dbClient.query(
      `SELECT DISTINCT a.id, a.name, a.status, a.user_id, a.container_id, a.backend_type,
              a.runtime_family, a.deploy_target, a.execution_target_id, a.sandbox_profile,
              a.host, a.runtime_host, a.runtime_port, a.gateway_host, a.gateway_port
         FROM agents a
         JOIN agent_budgets b ON b.agent_id = a.id
        WHERE a.status IN ('running', 'warning')`,
    );
    for (const agent of result.rows) {
      try {
        await checkAndEnforce(agent, deps);
      } catch {
        // Per-agent failures must not stop the sweep.
      }
    }
  } catch {
    // Budget sweeping is best-effort only.
  }
}

module.exports = {
  PAUSED_REASON_BUDGET,
  PERIOD_DAYS,
  VALID_PERIODS,
  checkAndEnforce,
  clearPausedReason,
  deleteBudget,
  listBudgets,
  listBudgetsWithSpend,
  recordBudgetAlert,
  serializeBudget,
  sweepAgentBudgets,
  upsertBudget,
};
