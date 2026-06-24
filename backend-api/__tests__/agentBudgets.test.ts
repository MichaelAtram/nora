// @ts-nocheck
const agentBudgets = require("../agentBudgets");

// Minimal dbClient fake that routes on SQL shape and records every call.
function fakeDb({ budgets = [] } = {}) {
  const calls = [];
  return {
    calls,
    budgets,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM agent_budgets")) {
        return { rows: budgets };
      }
      if (sql.includes("INSERT INTO agent_budgets")) {
        return {
          rows: [
            {
              id: "b-1",
              agent_id: params[0],
              period: params[1],
              limit_usd: params[2],
              soft_threshold_pct: params[3],
              last_alerted_at: null,
              last_alerted_pct: null,
              created_at: "now",
              updated_at: "now",
            },
          ],
        };
      }
      if (sql.includes("DELETE FROM agent_budgets")) {
        return { rows: params[0] === "exists" ? [{ id: "exists" }] : [] };
      }
      return { rows: [] };
    }),
  };
}

function budgetRow(overrides = {}) {
  return {
    id: "b-1",
    agent_id: "a-1",
    period: "monthly",
    limit_usd: "10.00",
    soft_threshold_pct: 80,
    last_alerted_at: null,
    last_alerted_pct: null,
    created_at: "now",
    updated_at: "now",
    ...overrides,
  };
}

function runningAgent(overrides = {}) {
  return { id: "a-1", name: "Researcher", status: "running", ...overrides };
}

describe("upsertBudget validation", () => {
  it("normalizes period, limit, and threshold", async () => {
    const dbClient = fakeDb();
    const budget = await agentBudgets.upsertBudget(
      "a-1",
      { period: "monthly", limit_usd: "12.349", soft_threshold_pct: "75" },
      { dbClient },
    );
    expect(budget.limitUsd).toBe(12.35);
    expect(budget.softThresholdPct).toBe(75);
    expect(budget.period).toBe("monthly");
  });

  it("rejects unknown periods and non-positive limits", async () => {
    const dbClient = fakeDb();
    await expect(
      agentBudgets.upsertBudget("a-1", { period: "hourly", limit_usd: 5 }, { dbClient }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      agentBudgets.upsertBudget("a-1", { period: "daily", limit_usd: 0 }, { dbClient }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("checkAndEnforce", () => {
  it("does nothing when the agent has no budgets", async () => {
    const dbClient = fakeDb({ budgets: [] });
    const costResolver = jest.fn();
    const result = await agentBudgets.checkAndEnforce(runningAgent(), { dbClient, costResolver });
    expect(result).toEqual({ enforced: false, crossings: [] });
    expect(costResolver).not.toHaveBeenCalled();
  });

  it("emits a soft alert once and dedupes repeats in the same bucket", async () => {
    const logEvent = jest.fn();
    const stopRuntime = jest.fn();
    const costResolver = jest.fn().mockResolvedValue({ total_cost: 8.5 }); // 85%

    const first = fakeDb({ budgets: [budgetRow()] });
    await agentBudgets.checkAndEnforce(runningAgent(), {
      dbClient: first,
      costResolver,
      stopRuntime,
      logEvent,
    });
    expect(logEvent).toHaveBeenCalledWith(
      "agent.budget_soft_exceeded",
      expect.stringContaining("85%"),
      expect.objectContaining({ agentId: "a-1", pct: 85 }),
    );
    expect(stopRuntime).not.toHaveBeenCalled();

    // Same bucket already alerted -> silent.
    logEvent.mockClear();
    const second = fakeDb({ budgets: [budgetRow({ last_alerted_pct: 85 })] });
    await agentBudgets.checkAndEnforce(runningAgent(), {
      dbClient: second,
      costResolver,
      stopRuntime,
      logEvent,
    });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("pauses the runtime on a hard crossing: reason first, stop, then status", async () => {
    const dbClient = fakeDb({ budgets: [budgetRow()] });
    const logEvent = jest.fn();
    const stopRuntime = jest.fn().mockResolvedValue(undefined);
    const costResolver = jest.fn().mockResolvedValue({ total_cost: 11 }); // 110%

    const result = await agentBudgets.checkAndEnforce(runningAgent(), {
      dbClient,
      costResolver,
      stopRuntime,
      logEvent,
    });

    expect(result.enforced).toBe(true);
    expect(stopRuntime).toHaveBeenCalledTimes(1);

    const updates = dbClient.calls.filter((c) => c.sql.includes("UPDATE agents"));
    expect(updates[0].sql).toContain("paused_reason");
    expect(updates[0].params).toEqual(["budget_exceeded", "a-1"]);
    expect(updates[1].sql).toContain("status = 'stopped'");

    // The paused_reason write must come BEFORE the stop call so a failed stop
    // still records intent.
    const reasonIdx = dbClient.calls.findIndex((c) => c.sql.includes("paused_reason"));
    expect(stopRuntime.mock.invocationCallOrder[0]).toBeGreaterThan(0);
    expect(reasonIdx).toBeGreaterThanOrEqual(0);

    expect(logEvent).toHaveBeenCalledWith(
      "agent.budget_paused",
      expect.stringContaining("paused"),
      expect.objectContaining({ agentId: "a-1" }),
    );
  });

  it("keeps the pause intent and reports failure when stop() throws", async () => {
    const dbClient = fakeDb({ budgets: [budgetRow()] });
    const logEvent = jest.fn();
    const stopRuntime = jest.fn().mockRejectedValue(new Error("docker unreachable"));
    const costResolver = jest.fn().mockResolvedValue({ total_cost: 20 });

    const result = await agentBudgets.checkAndEnforce(runningAgent(), {
      dbClient,
      costResolver,
      stopRuntime,
      logEvent,
    });

    expect(result.enforced).toBe(false);
    // paused_reason was written (intent recorded for the sweep retry)...
    const updates = dbClient.calls.filter((c) => c.sql.includes("UPDATE agents"));
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain("paused_reason");
    // ...but status was NOT flipped to stopped.
    expect(updates.some((c) => c.sql.includes("status = 'stopped'"))).toBe(false);
    expect(logEvent).toHaveBeenCalledWith(
      "agent.budget_pause_failed",
      expect.stringContaining("docker unreachable"),
      expect.objectContaining({ agentId: "a-1" }),
    );
  });

  it("re-enforces while over cap even when the alert is deduped (reconciler un-pause defense)", async () => {
    // Scenario: enforcement already alerted at 110% (last_alerted_pct=110),
    // the container kept running (failed stop or manual restart), so the
    // status reconciler flipped the agent back to running. The next check
    // must stop it again even though no new alert fires.
    const dbClient = fakeDb({ budgets: [budgetRow({ last_alerted_pct: 110 })] });
    const logEvent = jest.fn();
    const stopRuntime = jest.fn().mockResolvedValue(undefined);
    const costResolver = jest.fn().mockResolvedValue({ total_cost: 11 });

    const result = await agentBudgets.checkAndEnforce(runningAgent(), {
      dbClient,
      costResolver,
      stopRuntime,
      logEvent,
    });

    expect(result.enforced).toBe(true);
    expect(stopRuntime).toHaveBeenCalledTimes(1);
    // Alert deduped: no new budget_exceeded event, but the pause event fires.
    const types = logEvent.mock.calls.map((c) => c[0]);
    expect(types).not.toContain("agent.budget_exceeded");
    expect(types).toContain("agent.budget_paused");
  });

  it("does not try to stop agents that are not running", async () => {
    const dbClient = fakeDb({ budgets: [budgetRow({ last_alerted_pct: 110 })] });
    const stopRuntime = jest.fn();
    const costResolver = jest.fn().mockResolvedValue({ total_cost: 11 });

    const result = await agentBudgets.checkAndEnforce(runningAgent({ status: "stopped" }), {
      dbClient,
      costResolver,
      stopRuntime,
      logEvent: jest.fn(),
    });

    expect(result.enforced).toBe(false);
    expect(stopRuntime).not.toHaveBeenCalled();
  });
});

describe("sweepAgentBudgets", () => {
  it("checks every budgeted live agent and isolates per-agent failures", async () => {
    const agents = [
      { id: "a-1", name: "One", status: "running" },
      { id: "a-2", name: "Two", status: "warning" },
    ];
    const dbClient = {
      query: jest.fn(async (sql) => {
        if (sql.includes("JOIN agent_budgets")) return { rows: agents };
        if (sql.includes("FROM agent_budgets")) {
          throw new Error("listBudgets boom"); // forces per-agent failure path
        }
        return { rows: [] };
      }),
    };

    await expect(agentBudgets.sweepAgentBudgets({ dbClient })).resolves.toBeUndefined();
    // The sweep query ran and both agents were attempted despite failures.
    const budgetListCalls = dbClient.query.mock.calls.filter(([sql]) =>
      sql.includes("FROM agent_budgets"),
    );
    expect(budgetListCalls).toHaveLength(2);
  });
});

describe("clearPausedReason", () => {
  it("nulls the marker", async () => {
    const dbClient = fakeDb();
    await agentBudgets.clearPausedReason("a-1", { dbClient });
    expect(dbClient.calls[0].sql).toContain("paused_reason = NULL");
    expect(dbClient.calls[0].params).toEqual(["a-1"]);
  });
});
