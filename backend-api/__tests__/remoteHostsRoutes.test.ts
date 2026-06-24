// @ts-nocheck
/**
 * __tests__/remoteHostsRoutes.test.ts — operator + admin remote-host routes.
 * Mocks the remoteHosts registry so we assert routing, per-owner scoping, and
 * ownership enforcement without standing up Postgres.
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDb = { query: jest.fn().mockResolvedValue({ rows: [] }), connect: jest.fn() };
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
  enforceLimits: jest.fn().mockResolvedValue({ allowed: true }),
  getSubscription: jest.fn().mockResolvedValue({ plan: "selfhosted" }),
}));

const mockRemoteHosts = {
  listRemoteHosts: jest.fn(),
  listAccessibleRemoteHosts: jest.fn().mockResolvedValue([]),
  createRemoteHost: jest.fn(),
  updateRemoteHost: jest.fn(),
  deleteRemoteHost: jest.fn(),
  testRemoteHost: jest.fn(),
  getRemoteHost: jest.fn(),
  shareRemoteHost: jest.fn().mockResolvedValue(undefined),
  unshareRemoteHost: jest.fn().mockResolvedValue(undefined),
  listRemoteHostShares: jest.fn().mockResolvedValue([]),
  // imported elsewhere (worker/containerManager); stubbed so server boot is happy
  getRemoteHostProfile: jest.fn(),
  isRemoteDockerTarget: jest.fn(),
  listRemoteHostExecutionTargets: jest.fn().mockResolvedValue([]),
};
jest.mock("../remoteHosts", () => mockRemoteHosts);

const app = require("../server");
const userToken = jwt.sign({ id: "user-1", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
const otherToken = jwt.sign({ id: "user-2", role: "user" }, JWT_SECRET, { expiresIn: "1h" });
const adminToken = jwt.sign({ id: "admin-1", role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
const auth = (req, token) => req.set("Authorization", `Bearer ${token}`);

beforeEach(() => {
  for (const fn of Object.values(mockRemoteHosts)) {
    if (typeof fn?.mockReset === "function") fn.mockReset();
  }
  mockRemoteHosts.listRemoteHostExecutionTargets.mockResolvedValue([]);
});

describe("operator remote-host routes", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/remote-hosts");
    expect(res.status).toBe(401);
  });

  it("lists hosts the caller can access (owned + shared)", async () => {
    mockRemoteHosts.listAccessibleRemoteHosts.mockResolvedValue([
      { id: "my-laptop", ownerUserId: "user-1", access: "owned", canDeploy: true },
      { id: "team-vps", ownerUserId: "user-2", access: "shared", canDeploy: true },
    ]);
    const res = await auth(request(app).get("/remote-hosts"), userToken);
    expect(res.status).toBe(200);
    expect(mockRemoteHosts.listAccessibleRemoteHosts).toHaveBeenCalledWith("user-1");
    expect(res.body.map((h) => h.id)).toEqual(["my-laptop", "team-vps"]);
  });

  it("creates a host owned by the caller", async () => {
    mockRemoteHosts.createRemoteHost.mockResolvedValue({
      id: "vps-1",
      label: "VPS",
      ownerUserId: "user-1",
    });
    const res = await auth(request(app).post("/remote-hosts"), userToken).send({
      id: "vps-1",
      sshHost: "1.2.3.4",
      sshUser: "root",
      sshPrivateKey: "KEY",
    });
    expect(res.status).toBe(201);
    expect(mockRemoteHosts.createRemoteHost).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: "user-1", sshHost: "1.2.3.4" }),
    );
  });

  it("updates a host the caller owns", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-1" });
    mockRemoteHosts.updateRemoteHost.mockResolvedValue({ id: "vps-1", label: "Renamed" });
    const res = await auth(request(app).put("/remote-hosts/vps-1"), userToken).send({
      label: "Renamed",
    });
    expect(res.status).toBe(200);
    expect(mockRemoteHosts.updateRemoteHost).toHaveBeenCalledWith(
      "vps-1",
      expect.objectContaining({ ownerUserId: "user-1", label: "Renamed" }),
    );
  });

  it("returns 404 (not 403) when mutating another operator's host", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-2" });
    const res = await auth(request(app).delete("/remote-hosts/vps-1"), userToken);
    expect(res.status).toBe(404);
    expect(mockRemoteHosts.deleteRemoteHost).not.toHaveBeenCalled();
  });

  it("returns 404 when testing a host that does not exist", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue(null);
    const res = await auth(request(app).post("/remote-hosts/ghost/test"), userToken);
    expect(res.status).toBe(404);
    expect(mockRemoteHosts.testRemoteHost).not.toHaveBeenCalled();
  });

  it("tests a host the caller owns", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({
      id: "vps-1",
      ownerUserId: "user-1",
      label: "VPS",
    });
    mockRemoteHosts.testRemoteHost.mockResolvedValue({ id: "vps-1", lastTestStatus: "ok" });
    const res = await auth(request(app).post("/remote-hosts/vps-1/test"), userToken);
    expect(res.status).toBe(200);
    expect(res.body.lastTestStatus).toBe("ok");
  });

  it("rejects sharing a host the caller does not own (404)", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-2" });
    const res = await auth(
      request(app).post("/remote-hosts/vps-1/shares").send({ workspace_id: "ws-1" }),
      userToken,
    );
    expect(res.status).toBe(404);
    expect(mockRemoteHosts.shareRemoteHost).not.toHaveBeenCalled();
  });

  it("rejects a share with no workspace_id (400)", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-1" });
    const res = await auth(request(app).post("/remote-hosts/vps-1/shares").send({}), userToken);
    expect(res.status).toBe(400);
    expect(mockRemoteHosts.shareRemoteHost).not.toHaveBeenCalled();
  });

  it("lists a host's workspace shares (owner only)", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-1" });
    mockRemoteHosts.listRemoteHostShares.mockResolvedValue([
      { workspaceId: "ws-1", workspaceName: "Team" },
    ]);
    const res = await auth(request(app).get("/remote-hosts/vps-1/shares"), userToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ workspaceId: "ws-1", workspaceName: "Team" }]);
  });

  it("rejects listing shares for a host the caller does not own (404)", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-2" });
    const res = await auth(request(app).get("/remote-hosts/vps-1/shares"), userToken);
    expect(res.status).toBe(404);
  });

  it("rejects unsharing for a host the caller does not own (404)", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-2" });
    const res = await auth(request(app).delete("/remote-hosts/vps-1/shares/ws-1"), userToken);
    expect(res.status).toBe(404);
    expect(mockRemoteHosts.unshareRemoteHost).not.toHaveBeenCalled();
  });

  it("rejects sharing into a workspace the owner is not a member of (404)", async () => {
    mockRemoteHosts.getRemoteHost.mockResolvedValue({ id: "vps-1", ownerUserId: "user-1" });
    // findWorkspaceMembership queries db; default mock returns no rows → not a member.
    mockDb.query.mockResolvedValue({ rows: [] });
    const res = await auth(
      request(app).post("/remote-hosts/vps-1/shares").send({ workspace_id: "ws-x" }),
      userToken,
    );
    expect(res.status).toBe(404);
    expect(mockRemoteHosts.shareRemoteHost).not.toHaveBeenCalled();
  });
});

describe("admin remote-host fleet view", () => {
  it("lists every operator's hosts for an admin", async () => {
    mockRemoteHosts.listRemoteHosts.mockResolvedValue([
      { id: "a", ownerUserId: "user-1" },
      { id: "b", ownerUserId: "user-2" },
    ]);
    const res = await auth(request(app).get("/admin/remote-hosts"), adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // fleet view is NOT owner-scoped
    expect(mockRemoteHosts.listRemoteHosts).toHaveBeenCalledWith(
      expect.objectContaining({ includeDisabled: true }),
    );
    expect(mockRemoteHosts.listRemoteHosts.mock.calls[0][0].ownerUserId).toBeUndefined();
  });

  it("forbids a non-admin from the fleet view", async () => {
    const res = await auth(request(app).get("/admin/remote-hosts"), otherToken);
    expect(res.status).toBe(403);
  });
});
