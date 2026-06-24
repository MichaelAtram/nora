// @ts-nocheck
// Fleet "needs attention" roll-up. Derives, at read time, which agents an
// operator should look at right now and why — without adding any state: the
// signals come from columns/tables that already exist (agents.status +
// paused_reason, the latest deployments row for "entered the deploy pipeline
// at", the latest container_stats row for telemetry staleness, and
// agent_budgets.last_alerted_pct for a soft budget crossing).
//
// deriveAttention is a pure function (plain values in, plain object out) so the
// thresholds and reason logic are unit-testable without a database.

const db = require("./db");

// Thresholds (minutes). Deliberately conservative to avoid false alarms.
const STUCK_DEPLOY_MINUTES = 10; // queued/deploying longer than this = stuck
const STALE_TELEMETRY_MINUTES = 5; // running but no container_stats this recent

const MINUTE_MS = 60 * 1000;

// Reason severity ordering, highest first — drives sort + chip colour.
const SEVERITY_RANK = { error: 0, warning: 1 };

function minutesSince(fromMs, nowMs) {
  if (fromMs == null) return null;
  return (nowMs - fromMs) / MINUTE_MS;
}

// Pure: given an agent and the derived context numbers, return its attention
// verdict. ctx timestamps are epoch ms (or null); now defaults to "now".
function deriveAttention(agent, ctx = {}) {
  const {
    now = Date.now(),
    enteredDeployAt = null,
    lastStatAt = null,
    budgetSoftCrossed = false,
    stuckDeployMinutes = STUCK_DEPLOY_MINUTES,
    staleTelemetryMinutes = STALE_TELEMETRY_MINUTES,
  } = ctx;

  const status = agent?.status;
  const reasons = [];

  if (status === "error") {
    reasons.push({ code: "error", severity: "error", label: "Errored" });
  }

  if (status === "warning") {
    reasons.push({ code: "warning", severity: "warning", label: "Degraded" });
  }

  if (status === "stopped" && agent?.paused_reason === "budget_exceeded") {
    reasons.push({
      code: "budget_paused",
      severity: "error",
      label: "Paused — budget cap reached",
    });
  }

  if (status === "queued" || status === "deploying") {
    const ageMin = minutesSince(enteredDeployAt, now);
    if (ageMin != null && ageMin >= stuckDeployMinutes) {
      reasons.push({
        code: "stuck_deploying",
        severity: "warning",
        label: `Stuck ${status} for ${Math.floor(ageMin)}m`,
      });
    }
  }

  if (status === "running" || status === "warning") {
    if (budgetSoftCrossed) {
      reasons.push({
        code: "budget_warning",
        severity: "warning",
        label: "Approaching budget cap",
      });
    }
    // Only flag stalled telemetry when stats exist but are old — a never-yet-
    // reported brand-new agent (lastStatAt null) is not "stalled".
    const staleMin = minutesSince(lastStatAt, now);
    if (staleMin != null && staleMin >= staleTelemetryMinutes) {
      reasons.push({
        code: "telemetry_stalled",
        severity: "warning",
        label: `No telemetry for ${Math.floor(staleMin)}m`,
      });
    }
  }

  reasons.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    agentId: agent?.id,
    name: agent?.name || null,
    status: status || null,
    runtimeFamily: agent?.runtime_family || null,
    deployTarget: agent?.deploy_target || null,
    needsAttention: reasons.length > 0,
    severity: reasons[0]?.severity || null,
    reasons,
  };
}

// Gather the per-agent signals for every agent the user can access (direct
// ownership or workspace membership), then derive attention for each. Returns
// only the agents that need attention, plus summary counts. Deps are injectable
// for testing.
async function getFleetAttention({ userId, dbClient = db, now = Date.now() } = {}) {
  if (!userId) {
    return { generatedAt: new Date(now).toISOString(), total: 0, attentionCount: 0, agents: [] };
  }

  const result = await dbClient.query(
    `SELECT a.id, a.name, a.status, a.paused_reason, a.runtime_family, a.deploy_target,
            dep.created_at AS entered_deploy_at,
            st.recorded_at AS last_stat_at,
            COALESCE(bud.soft_crossed, false) AS budget_soft_crossed
       FROM agents a
       LEFT JOIN LATERAL (
         SELECT created_at FROM deployments d
          WHERE d.agent_id = a.id ORDER BY d.created_at DESC LIMIT 1
       ) dep ON true
       LEFT JOIN LATERAL (
         SELECT recorded_at FROM container_stats s
          WHERE s.agent_id = a.id ORDER BY s.recorded_at DESC LIMIT 1
       ) st ON true
       LEFT JOIN LATERAL (
         SELECT bool_or(b.last_alerted_pct >= b.soft_threshold_pct AND b.last_alerted_pct < 100)
                  AS soft_crossed
           FROM agent_budgets b WHERE b.agent_id = a.id
       ) bud ON true
      WHERE a.user_id = $1
         OR a.id IN (
              SELECT wa.agent_id FROM workspace_agents wa
                JOIN workspace_members wm ON wm.workspace_id = wa.workspace_id
               WHERE wm.user_id = $1
            )`,
    [userId],
  );

  const toMs = (value) => (value == null ? null : new Date(value).getTime());
  const items = result.rows.map((row) =>
    deriveAttention(row, {
      now,
      enteredDeployAt: toMs(row.entered_deploy_at),
      lastStatAt: toMs(row.last_stat_at),
      budgetSoftCrossed: row.budget_soft_crossed === true,
    }),
  );

  const attention = items.filter((item) => item.needsAttention);
  // Errors before warnings; otherwise stable.
  attention.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    generatedAt: new Date(now).toISOString(),
    total: items.length,
    attentionCount: attention.length,
    agents: attention,
  };
}

module.exports = {
  STUCK_DEPLOY_MINUTES,
  STALE_TELEMETRY_MINUTES,
  deriveAttention,
  getFleetAttention,
};
