// @ts-nocheck
const doctor = require("../doctor");

const NOW = Date.UTC(2026, 5, 12, 12, 0, 0);

function okDb(overrides = {}) {
  // Routes by SQL shape: SELECT 1, the fleet query, the gateway-exposure count.
  return {
    query: jest.fn(async (sql) => {
      if (/SELECT 1/.test(sql)) return { rows: [{ "?column?": 1 }] };
      if (/FROM agents a/.test(sql)) return { rows: overrides.fleetRows || [] };
      if (/gateway_host_port IS NOT NULL/.test(sql))
        return { rows: [{ exposed: overrides.exposed ?? 0 }] };
      return { rows: [] };
    }),
  };
}

const okQueue = { getJobCounts: async () => ({ waiting: 0, active: 0, completed: 5, failed: 0 }) };
const noDlq = async () => [];
const noClusters = async () => [];

const HEX64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const healthyDeps = (over = {}) => ({
  dbClient: okDb(over.db || {}),
  queue: over.queue || okQueue,
  dlqJobs: over.dlqJobs || noDlq,
  listKubernetesTargets: over.listKubernetesTargets || noClusters,
  env: over.env || {
    JWT_SECRET: "a-properly-long-jwt-secret-value",
    NORA_API_KEY_HASH_SECRET: "a-properly-long-hash-secret-value",
    ENCRYPTION_KEY: HEX64,
  },
  now: NOW,
});

beforeEach(() => doctor._resetCacheForTests());

describe("checkSecrets", () => {
  it("passes with strong, present secrets", () => {
    const r = doctor.checkSecrets({
      JWT_SECRET: "a-properly-long-jwt-secret-value",
      NORA_API_KEY_HASH_SECRET: "a-properly-long-hash-secret-value",
      ENCRYPTION_KEY: HEX64,
    });
    expect(r.status).toBe("ok");
    expect(r.problems).toEqual([]);
  });

  it("fails on missing JWT/encryption secrets; missing hash secret is a warn (legacy fallback)", () => {
    const r = doctor.checkSecrets({ ENCRYPTION_KEY: "" });
    expect(r.status).toBe("fail");
    const byEnv = Object.fromEntries(r.problems.map((p) => [p.env, p]));
    expect(byEnv.JWT_SECRET.severity).toBe("fail");
    expect(byEnv.ENCRYPTION_KEY.severity).toBe("fail");
    // lib/apiTokens has a legacy fallback chain, so absence is only a warning.
    expect(byEnv.NORA_API_KEY_HASH_SECRET.severity).toBe("warn");
  });

  it("rejects a non-hex encryption key", () => {
    const r = doctor.checkSecrets({
      JWT_SECRET: "a-properly-long-jwt-secret-value",
      NORA_API_KEY_HASH_SECRET: "a-properly-long-hash-secret-value",
      ENCRYPTION_KEY: "not-a-hex-key-but-long-enough-to-pass-length",
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/64-character hex/);
  });

  it("flags placeholder values", () => {
    const r = doctor.checkSecrets({
      JWT_SECRET: "changeme-please",
      NORA_API_KEY_HASH_SECRET: "your_secret_here",
      ENCRYPTION_KEY: HEX64,
    });
    expect(r.status).toBe("fail");
    expect(r.problems.map((p) => p.issue)).toEqual(
      expect.arrayContaining([expect.stringContaining("placeholder")]),
    );
  });
});

describe("runDoctor", () => {
  it("reports overall ok when every check is healthy", async () => {
    const report = await doctor.runDoctor(healthyDeps());
    expect(report.overall).toBe("ok");
    expect(report.checks.map((c) => c.id).sort()).toEqual([
      "database",
      "fleet",
      "gateway_exposure",
      "kubernetes",
      "queue",
      "secrets",
    ]);
    expect(report.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it("degrades a thrown check to fail without taking down the report", async () => {
    const queue = {
      getJobCounts: async () => {
        throw new Error("redis down");
      },
    };
    const report = await doctor.runDoctor(healthyDeps({ queue }));
    const queueCheck = report.checks.find((c) => c.id === "queue");
    expect(queueCheck.status).toBe("fail");
    expect(queueCheck.detail).toMatch(/redis down/);
    expect(report.overall).toBe("fail");
    // Other checks still ran.
    expect(report.checks.find((c) => c.id === "database").status).toBe("ok");
  });

  it("warns when a Kubernetes target has not passed a connection test", async () => {
    const listKubernetesTargets = async () => [
      { id: "k1", label: "prod", lastTestStatus: "ok" },
      { id: "k2", label: "staging", lastTestStatus: "failed", lastTestMessage: "timeout" },
    ];
    const report = await doctor.runDoctor(healthyDeps({ listKubernetesTargets }));
    const k = report.checks.find((c) => c.id === "kubernetes");
    expect(k.status).toBe("warn");
    expect(k.targets).toHaveLength(1);
    expect(k.targets[0].id).toBe("k2");
    expect(report.overall).toBe("warn");
  });

  it("escalates fleet health to fail when an agent is errored", async () => {
    const db = okDb({ fleetRows: [{ id: "a", name: "A", status: "error" }] });
    const report = await doctor.runDoctor({ ...healthyDeps(), dbClient: db });
    const fleet = report.checks.find((c) => c.id === "fleet");
    expect(fleet.status).toBe("fail");
    expect(fleet.attentionCount).toBe(1);
    expect(fleet.reasons.error).toBe(1);
  });

  it("surfaces host-published gateways", async () => {
    const report = await doctor.runDoctor(healthyDeps({ db: { exposed: 3 } }));
    const gw = report.checks.find((c) => c.id === "gateway_exposure");
    expect(gw.exposed).toBe(3);
    expect(gw.detail).toMatch(/firewall/);
  });
});

describe("getDoctorReport caching", () => {
  it("serves a cached report within the TTL and recomputes on fresh", async () => {
    const deps = healthyDeps();
    const first = await doctor.getDoctorReport({}, deps);
    const callsAfterFirst = deps.dbClient.query.mock.calls.length;
    // Within TTL (same now) — cached, no new DB calls.
    await doctor.getDoctorReport({}, deps);
    expect(deps.dbClient.query.mock.calls.length).toBe(callsAfterFirst);
    // fresh=true recomputes.
    await doctor.getDoctorReport({ fresh: true }, deps);
    expect(deps.dbClient.query.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(first.overall).toBe("ok");
  });
});
