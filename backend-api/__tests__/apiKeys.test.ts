// @ts-nocheck
/**
 * __tests__/apiKeys.test.ts — workspace-scoped API key issuance, listing,
 * revocation, and verification. Mocks db so the SQL surface is pinned without
 * needing Postgres. Also covers the auth middleware's API-key intake path
 * (Bearer "nora_..." tokens) end-to-end.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;
process.env.NORA_API_KEY_HASH_SECRET = "test-api-key-hash-secret-must-be-32+chars-long";

const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);
jest.mock("../redisQueue", () => ({
  addDeploymentJob: jest.fn(),
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
}));
jest.mock("../scheduler", () => ({ selectNode: jest.fn() }));
jest.mock("../containerManager", () => ({
  start: jest.fn(),
  stop: jest.fn(),
  restart: jest.fn(),
  destroy: jest.fn(),
  status: jest.fn().mockResolvedValue({ running: true }),
}));
jest.mock("../monitoring", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
  getMetrics: jest.fn().mockResolvedValue({}),
  getRecentEvents: jest.fn().mockResolvedValue([]),
}));
jest.mock("../billing", () => ({
  BILLING_ENABLED: false,
  PLATFORM_MODE: "selfhosted",
  IS_PAAS: false,
  enforceLimits: jest
    .fn()
    .mockResolvedValue({ allowed: true, subscription: { plan: "selfhosted" } }),
  getSubscription: jest.fn().mockResolvedValue({ plan: "selfhosted" }),
}));

const apiKeys = require("../apiKeys");

beforeEach(() => {
  mockDb.query.mockReset();
});

describe("apiKeys.createApiKey", () => {
  it("validates that scopes are non-empty", async () => {
    await expect(
      apiKeys.createApiKey("ws-1", "user-1", { label: "Test", scopes: [] }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects unknown scopes", async () => {
    await expect(
      apiKeys.createApiKey("ws-1", "user-1", { label: "T", scopes: ["agents:nuke"] }),
    ).rejects.toThrow(/Unknown API scope/);
  });

  it("issues a key with prefix nora_, returns the raw token once", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "k-1",
          workspace_id: "ws-1",
          created_by: "user-1",
          label: "Test",
          key_prefix: "nora_xxxx",
          scopes: ["agents:read"],
          status: "active",
          created_at: new Date().toISOString(),
        },
      ],
    });

    const created = await apiKeys.createApiKey("ws-1", "user-1", {
      label: "Test",
      scopes: ["agents:read"],
    });

    expect(created.apiKey).toMatch(/^nora_/);
    expect(created.id).toBe("k-1");
    expect(created.scopes).toEqual(["agents:read"]);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const [, params] = mockDb.query.mock.calls[0];
    // workspace_id, created_by, label, key_hash, key_prefix, scopes_json, status, expires_at
    expect(params[0]).toBe("ws-1");
    expect(params[1]).toBe("user-1");
    expect(params[6]).toBe("active");
    expect(params[3]).toMatch(/^[a-f0-9]{64}$/); // hex sha256
  });

  it("rejects when workspaceId missing", async () => {
    await expect(
      apiKeys.createApiKey(null, "user-1", { label: "T", scopes: ["agents:read"] }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("apiKeys.verifyApiKey", () => {
  it("returns null when token is empty", async () => {
    expect(await apiKeys.verifyApiKey("")).toBeNull();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("returns null when no row matches", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    expect(await apiKeys.verifyApiKey("nora_xxx")).toBeNull();
  });

  it("returns the key + workspace + user envelope on a match", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-1",
            workspace_id: "ws-1",
            created_by: "user-1",
            key_hash: "doesnotmatter",
            key_prefix: "nora_xxxx",
            scopes: ["agents:read"],
            status: "active",
            workspace_name: "Prod",
            user_email: "owner@x.com",
            user_role: "user",
            user_name: "Owner",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // last_used_at update (or rehash)

    const verified = await apiKeys.verifyApiKey("nora_anytoken");
    expect(verified).toMatchObject({
      key: { id: "k-1", scopes: ["agents:read"] },
      workspace: { id: "ws-1", name: "Prod" },
      user: { id: "user-1", email: "owner@x.com" },
    });
  });
});

describe("API key endpoints (HTTP)", () => {
  // Lazily require the app so jest mocks above are applied.
  jest.mock("../workspaces", () => ({
    listWorkspaces: jest.fn().mockResolvedValue([]),
    createWorkspace: jest.fn(),
    addAgent: jest.fn(),
    getWorkspaceAgents: jest.fn().mockResolvedValue([]),
    listAgentCandidates: jest.fn().mockResolvedValue([]),
    removeAgent: jest.fn(),
    listAccessibleAgents: jest.fn().mockResolvedValue([]),
  }));
  jest.mock("../workspaceMembers", () => ({
    listMembers: jest.fn().mockResolvedValue([]),
    listInvitations: jest.fn().mockResolvedValue([]),
  }));
  jest.mock("../integrations", () => ({}));
  jest.mock("../channels", () => ({}));
  jest.mock("../llmProviders", () => ({
    getAvailableProviders: jest.fn().mockReturnValue([]),
    listProviders: jest.fn().mockResolvedValue([]),
    PROVIDERS: [],
  }));
  jest.mock("../metrics", () => ({
    parseCostQuery: jest.fn((query = {}) => ({ periodDays: Number(query.period_days) || 30 })),
    recordApiMetric: jest.fn(),
    getAgentSummary: jest.fn().mockResolvedValue({}),
    getAgentMetrics: jest.fn().mockResolvedValue([]),
    getAgentCost: jest.fn().mockResolvedValue(null),
    getWorkspaceCost: jest.fn().mockResolvedValue({ totalUsd: 0, perAgent: [] }),
    getAccessibleWorkspaceCosts: jest
      .fn()
      .mockResolvedValue({ workspaces: [], uniqueFleetTotalUsd: 0 }),
  }));

  const app = require("../server");
  const userToken = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
  const auth = (req) => req.set("Authorization", `Bearer ${userToken}`);

  it("GET /workspaces/:id/api-keys/scopes returns the scope catalog", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "user-1", role: "viewer" }],
    });

    const res = await auth(request(app).get("/workspaces/ws-1/api-keys/scopes"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.find((s) => s.value === "agents:read")).toBeDefined();
    expect(res.body.find((s) => s.value === "admin:read")).toBeDefined();
  });

  it("POST /workspaces/:id/api-keys requires admin role", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: "ws-1", user_id: "creator", role: "editor" }],
    });
    const res = await auth(
      request(app)
        .post("/workspaces/ws-1/api-keys")
        .send({ label: "ci", scopes: ["agents:read"] }),
    );
    expect(res.status).toBe(403);
  });

  it("POST /workspaces/:id/api-keys issues a key for admins", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "ws-1", user_id: "creator", role: "admin" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-1",
            workspace_id: "ws-1",
            created_by: "user-1",
            label: "ci",
            key_prefix: "nora_abcd",
            scopes: ["agents:read"],
            status: "active",
            created_at: new Date().toISOString(),
          },
        ],
      });

    const res = await auth(
      request(app)
        .post("/workspaces/ws-1/api-keys")
        .send({ label: "ci", scopes: ["agents:read"] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toMatch(/^nora_/);
    expect(res.body.scopes).toEqual(["agents:read"]);
  });

  it("DELETE /workspaces/:id/api-keys/:keyId revokes when admin", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: "ws-1", user_id: "creator", role: "admin" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-1",
            workspace_id: "ws-1",
            label: "old",
            key_prefix: "nora_xxx",
            scopes: ["agents:read"],
            status: "revoked",
            created_at: new Date().toISOString(),
          },
        ],
      });

    const res = await auth(request(app).delete("/workspaces/ws-1/api-keys/k-1"));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("revoked");
  });
});

describe("auth middleware: API key intake", () => {
  const app = require("../server");

  it("rejects bearer 'nora_...' that doesn't verify", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // verifyApiKey misses
    const res = await request(app)
      .get("/workspaces")
      .set("Authorization", "Bearer nora_invalid_token_value_here");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid or expired API key/);
  });

  it("authenticates a request with a valid 'nora_' Bearer", async () => {
    mockDb.query
      // verifyApiKey: matched row + workspace + user joined
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-1",
            workspace_id: "ws-1",
            created_by: "user-1",
            key_hash: "anything",
            key_prefix: "nora_yyyy",
            scopes: ["workspaces:read"],
            status: "active",
            workspace_name: "Prod",
            user_email: "owner@x.com",
            user_role: "user",
            user_name: "Owner",
          },
        ],
      })
      // verifyApiKey: last_used_at update
      .mockResolvedValueOnce({ rows: [] })
      // listWorkspaces (the route the request lands on) — return empty for simplicity
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/workspaces")
      .set("Authorization", "Bearer nora_validtoken");
    expect(res.status).toBe(200);
  });

  it("rejects API-key request to /workspaces when scope is missing", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-3",
            workspace_id: "ws-1",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["agents:read"], // no workspaces:read
            status: "active",
            workspace_name: "Prod",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/workspaces")
      .set("Authorization", "Bearer nora_underscoped");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("missing_scope");
    expect(res.body.error).toMatch(/workspaces:read/);
  });

  it("keeps Agent Hub and backup state behind session authentication", async () => {
    const keyRow = {
      id: "k-sensitive",
      workspace_id: "ws-1",
      created_by: "user-1",
      key_hash: "h",
      key_prefix: "nora_p",
      scopes: ["agents:read", "agents:write", "integrations:read", "integrations:write"],
      status: "active",
      workspace_name: "Prod",
      user_email: "u@x.com",
      user_role: "user",
      user_name: "U",
    };

    mockDb.query.mockResolvedValueOnce({ rows: [keyRow] }).mockResolvedValueOnce({ rows: [] });
    const hub = await request(app)
      .get("/agent-hub")
      .set("Authorization", "Bearer nora_sensitive_hub");
    expect(hub.status).toBe(403);
    expect(hub.body.code).toBe("session_required");

    mockDb.query.mockResolvedValueOnce({ rows: [keyRow] }).mockResolvedValueOnce({ rows: [] });
    const backups = await request(app)
      .get("/agents/agent-1/backups")
      .set("Authorization", "Bearer nora_sensitive_backup");
    expect(backups.status).toBe(403);
    expect(backups.body.code).toBe("session_required");
  });

  it("requires integration scopes before an API key can reach channel ownership", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-channels",
            workspace_id: "ws-1",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["agents:read"],
            status: "active",
            workspace_name: "Prod",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/agents/agent-1/channels")
      .set("Authorization", "Bearer nora_channels_readonly");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("missing_scope");
    expect(res.body.error).toMatch(/integrations:read/);
  });

  it("requires the explicit admin:read scope for API-key doctor access", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-admin",
            workspace_id: "ws-1",
            created_by: "admin-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["monitoring:read"],
            status: "active",
            workspace_name: "Prod",
            user_email: "admin@x.com",
            user_role: "admin",
            user_name: "Admin",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/admin/doctor")
      .set("Authorization", "Bearer nora_admin_without_scope");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("missing_scope");
    expect(res.body.error).toMatch(/admin:read/);
  });

  it("blocks API keys from mutating workspaces (session-required)", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-4",
            workspace_id: "ws-1",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["workspaces:read"],
            status: "active",
            workspace_name: "Prod",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/workspaces")
      .set("Authorization", "Bearer nora_readonly")
      .send({ name: "Should Fail" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("session_required");
  });

  it("blocks API keys from issuing other API keys", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-5",
            workspace_id: "ws-1",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["workspaces:read"],
            status: "active",
            workspace_name: "Prod",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/workspaces/ws-1/api-keys")
      .set("Authorization", "Bearer nora_readonly");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("session_required");
  });

  // Regression: an API key issued in workspace A must not unlock workspace B,
  // even when the issuing user is a member of B. Pre-fix the workspace param
  // was only checked against the user's membership, not the key's binding.
  it("rejects an API key with cross-workspace access (workspace route)", async () => {
    mockDb.query
      // verifyApiKey: key bound to ws-A
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-cw",
            workspace_id: "ws-A",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["workspaces:read"],
            status: "active",
            workspace_name: "A",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // last_used_at update
    // No membership query should be issued — the workspace gate must reject
    // before findWorkspaceMembership runs. If the gate is bypassed, the next
    // mockResolvedValueOnce wouldn't exist and the request would 500/200.

    const res = await request(app)
      .get("/workspaces/ws-B/alert-rules")
      .set("Authorization", "Bearer nora_crossworkspace");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_workspace");
  });

  it("rejects an API key reaching another workspace's agent", async () => {
    mockDb.query
      // verifyApiKey: key bound to ws-A; needs both scopes because the request
      // crosses two scope-gated routers (agents.ts then monitoring.ts).
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-cwa",
            workspace_id: "ws-A",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["agents:read", "monitoring:read"],
            status: "active",
            workspace_name: "A",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // last_used_at update
      // workspace_agents lookup inside enforceApiKeyAgentScope: agent is NOT in ws-A
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/agents/agent-xyz/metrics")
      .set("Authorization", "Bearer nora_crossagent");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_workspace");
  });

  it("filters GET /workspaces to the API key's bound workspace only", async () => {
    mockDb.query
      // verifyApiKey: key bound to ws-A
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-list",
            workspace_id: "ws-A",
            created_by: "user-1",
            key_hash: "h",
            key_prefix: "nora_p",
            scopes: ["workspaces:read"],
            status: "active",
            workspace_name: "A",
            user_email: "u@x.com",
            user_role: "user",
            user_name: "U",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // last_used_at update

    // listWorkspaces is mocked at the top of this describe block to return [];
    // override it here to return both workspaces the user belongs to.
    const workspacesModule = require("../workspaces");
    workspacesModule.listWorkspaces.mockResolvedValueOnce([
      { id: "ws-A", name: "A", role: "owner" },
      { id: "ws-B", name: "B", role: "member" },
    ]);

    const res = await request(app).get("/workspaces").set("Authorization", "Bearer nora_listing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "ws-A", name: "A", role: "owner" }]);
  });

  it("falls back to API key intake when x-api-key header is set", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "k-2",
            workspace_id: "ws-1",
            created_by: null,
            key_hash: "h",
            key_prefix: "nora_zzzz",
            scopes: ["workspaces:read"],
            status: "active",
            workspace_name: "Prod",
            user_email: null,
            user_role: null,
            user_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/workspaces").set("x-api-key", "nora_some_other_token");
    expect(res.status).toBe(200);
  });
});
