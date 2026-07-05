// @ts-nocheck
// Workspace usage budgets. When a check sees that current spend has crossed
// the soft threshold (default 80%) or 100% of the limit, it emits an event
// (workspace.budget_soft_exceeded / workspace.budget_exceeded) — the alerting
// system can subscribe to those event types to deliver notifications.
//
// Re-alerting is rate-limited via last_alerted_pct: an alert at 80% won't
// re-fire at 81%, only when the bucket changes (80 → 100).

const db = require("./db");

const VALID_PERIODS = new Set(["daily", "weekly", "monthly"]);

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
    workspaceId: row.workspace_id,
    period: row.period,
    limitUsd: Number(row.limit_usd),
    softThresholdPct: row.soft_threshold_pct,
    lastAlertedAt: row.last_alerted_at,
    lastAlertedPct: row.last_alerted_pct,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listBudgets(workspaceId) {
  const result = await db.query(
    `SELECT id, workspace_id, period, limit_usd, soft_threshold_pct,
            last_alerted_at, last_alerted_pct, created_at, updated_at
       FROM workspace_budgets
      WHERE workspace_id = $1
      ORDER BY period`,
    [workspaceId],
  );
  return result.rows.map(serializeBudget);
}

async function upsertBudget(workspaceId, payload = {}) {
  const period = normalizePeriod(payload.period);
  const limitUsd = normalizeLimit(payload.limitUsd ?? payload.limit_usd);
  const softThresholdPct = normalizeThreshold(
    payload.softThresholdPct ?? payload.soft_threshold_pct,
  );

  const result = await db.query(
    `INSERT INTO workspace_budgets (workspace_id, period, limit_usd, soft_threshold_pct)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, period) DO UPDATE
       SET limit_usd = EXCLUDED.limit_usd,
           soft_threshold_pct = EXCLUDED.soft_threshold_pct,
           updated_at = NOW()
     RETURNING id, workspace_id, period, limit_usd, soft_threshold_pct,
               last_alerted_at, last_alerted_pct, created_at, updated_at`,
    [workspaceId, period, limitUsd, softThresholdPct],
  );
  return serializeBudget(result.rows[0]);
}

async function deleteBudget(budgetId, workspaceId) {
  const result = await db.query(
    "DELETE FROM workspace_budgets WHERE id = $1 AND workspace_id = $2 RETURNING id",
    [budgetId, workspaceId],
  );
  return Boolean(result.rows[0]);
}

const BUDGET_PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30 };

// Check current spend against budgets and return an array of bucket
// crossings (none / soft / hard). Callers (the cost route handler, or a
// background task) decide whether to emit events from the result.
// Spend is resolved PER BUDGET PERIOD — never from whatever window the
// viewer happened to select (that measured a daily $10 budget against
// 30-day spend and fired false alerts on every page view).
async function evaluateBudgetCrossings(workspaceId, _ignoredViewerWindowUsd, deps = {}) {
  const { costResolver = require("./metrics").getWorkspaceCost } = deps;
  const budgets = await listBudgets(workspaceId);
  const crossings = [];
  const spendByPeriod = new Map();
  for (const budget of budgets) {
    const periodDays = BUDGET_PERIOD_DAYS[budget.period] || 30;
    if (!spendByPeriod.has(periodDays)) {
      const cost = await costResolver(workspaceId, { periodDays });
      spendByPeriod.set(periodDays, Number(cost?.totalUsd ?? cost?.total_cost ?? 0));
    }
    const currentUsd = spendByPeriod.get(periodDays);
    const pct = budget.limitUsd > 0 ? Math.floor((currentUsd / budget.limitUsd) * 100) : 0;
    let bucket = "none";
    if (pct >= 100) bucket = "hard";
    else if (pct >= budget.softThresholdPct) bucket = "soft";
    if (bucket === "none") continue;

    // Skip if we already alerted for this bucket (or higher).
    const lastBucket =
      budget.lastAlertedPct == null
        ? "none"
        : budget.lastAlertedPct >= 100
          ? "hard"
          : budget.lastAlertedPct >= budget.softThresholdPct
            ? "soft"
            : "none";
    if (lastBucket === "hard") continue;
    if (lastBucket === "soft" && bucket === "soft") continue;

    crossings.push({ budget, bucket, currentUsd, pct });
  }
  return crossings;
}

async function recordBudgetAlert(budgetId, pct) {
  await db
    .query(
      `UPDATE workspace_budgets
          SET last_alerted_at = NOW(),
              last_alerted_pct = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [budgetId, pct],
    )
    .catch((err) => console.error("Failed to record budget alert:", err.message));
}

module.exports = {
  VALID_PERIODS,
  deleteBudget,
  evaluateBudgetCrossings,
  listBudgets,
  recordBudgetAlert,
  serializeBudget,
  upsertBudget,
};
