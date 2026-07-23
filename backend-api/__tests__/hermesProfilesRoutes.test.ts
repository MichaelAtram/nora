// @ts-nocheck
/**
 * __tests__/hermesProfilesRoutes.test.ts — Hermes profile CRUD routes and
 * `?profile=` scoping on the existing hermes-ui channel routes.
 *
 * This mirrors the express-app + auth-mock bootstrap used by agents.test.ts
 * (routes/agents.ts is mounted via the real server.ts, since loadHermesUiAgent
 * is an internal, non-exported helper — it can't be jest.mock'd the way
 * agentMigrationsRoutes.test.ts mocks a standalone router's dependencies).
 * Agent ownership/authorization is exercised for real through the mocked db
 * row, and only the Hermes-profile-specific modules are mocked at the
 * boundary.
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "secret";
process.env.JWT_SECRET = JWT_SECRET;

const mockDbClient = { query: jest.fn(), release: jest.fn() };
const mockDb = { query: jest.fn(), connect: jest.fn() };
const mockActivationLockClient = {
  connect: jest.fn(),
  query: jest.fn(),
  end: jest.fn(),
};
const mockPgClient = jest.fn(() => mockActivationLockClient);
const mockAddDeploymentJob = jest.fn();
const mockCancelDeploymentJobsForAgent = jest.fn();
const mockEnsureDemoProvider = jest.fn();
const mockDockerPing = jest.fn((callback) => callback(null));
const mockDockerInspect = jest.fn();
const mockStats = jest.fn();
const mockSyncAuthToUserAgents = jest.fn().mockResolvedValue([]);
const mockResumeAgentWithProviderAuth = jest.fn();
const mockWithProviderStateLock = jest.fn();
const mockPersistLifecycleRuntimeAddress = jest.fn();
const mockRunContainerCommand = jest.fn();
const mockListHermesChannels = jest.fn();
const mockSaveHermesChannel = jest.fn();
const mockDeleteHermesChannel = jest.fn();
const mockTestHermesChannel = jest.fn();
const mockReadHermesRuntimeSnapshot = jest.fn().mockResolvedValue({
  runtimeStatus: {
    gateway_state: "running",
    active_agents: 1,
    updated_at: "2026-04-12T12:00:00.000Z",
    platforms: {},
  },
  directory: {
    updated_at: "2026-04-12T12:00:00.000Z",
    platforms: {},
  },
  platformDetails: {},
  jobsCount: 0,
  modelConfig: {
    defaultModel: null,
    provider: null,
    baseUrl: null,
  },
});
const mockGetOwnedMigrationDraft = jest.fn();
const mockAttachDraftToAgent = jest.fn();
const mockMaterializeManagedMigrationState = jest.fn();
const mockBuildMigrationManifestFromAgent = jest.fn();
const mockPackMigrationBundle = jest.fn();
const mockRootsForAgent = jest.fn();
const mockListFiles = jest.fn();
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockDownloadPath = jest.fn();
const mockCreateDirectory = jest.fn();
const mockMovePath = jest.fn();
const mockDeletePath = jest.fn();
const mockNormalizeRelativePath = jest.fn((input, { allowEmpty = true } = {}) => {
  const raw = String(input || "").trim();
  if (!raw) return allowEmpty ? "" : null;
  return raw.replace(/^\/+/, "");
});
const mockGetDeploymentDefaults = jest.fn().mockResolvedValue({
  vcpu: 1,
  ram_mb: 1024,
  disk_gb: 10,
});
const mockGetAgentHubSourceApiKey = jest.fn().mockResolvedValue("nora_hub_test_key");
const mockAssertKubernetesExecutionTargetAvailable = jest.fn().mockResolvedValue();
const mockAssertRemoteHostExecutionTargetAvailable = jest.fn().mockResolvedValue();
const mockVerifyApiKey = jest.fn();
const mockGetAgentVersion = jest.fn();
const mockRecordAgentVersion = jest.fn();
const mockRecordAgentVersionBestEffort = jest.fn();
const mockAgentProvisionLockRelease = jest.fn().mockResolvedValue(undefined);
const mockAcquireAgentProvisionLock = jest.fn().mockResolvedValue({
  release: mockAgentProvisionLockRelease,
});

// Hermes profile CRUD module (Task 7) — the module under test in agents.ts
// consumes these directly.
const mockListHermesProfiles = jest.fn();
const mockCreateHermesProfile = jest.fn();
const mockDeleteHermesProfile = jest.fn();
const mockSetProfileGatewayState = jest.fn();
const mockAssertProfileExists = jest.fn();
const mockAssertProfileManagementSupported = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("../apiKeys", () => ({
  ...jest.requireActual("../apiKeys"),
  verifyApiKey: mockVerifyApiKey,
}));
jest.mock("pg", () => ({
  ...jest.requireActual("pg"),
  Client: mockPgClient,
}));
jest.mock("dockerode", () =>
  jest.fn().mockImplementation(() => ({
    ping: mockDockerPing,
    getContainer: jest.fn(() => ({ inspect: mockDockerInspect })),
  })),
);
jest.mock("../crypto", () => ({
  encrypt: (v) => (v == null || v === "" ? v : `enc(${v})`),
  decrypt: (v) => (typeof v === "string" && v.startsWith("enc(") ? v.slice(4, -1) : v),
  isEncryptionConfigured: () => true,
  ensureEncryptionConfigured: () => {},
  DecryptionError: class DecryptionError extends Error {},
}));
jest.mock("../redisQueue", () => ({
  addDeploymentJob: mockAddDeploymentJob,
  cancelDeploymentJobsForAgent: mockCancelDeploymentJobsForAgent,
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
}));
jest.mock("../agentProvisionLock", () => ({
  ...jest.requireActual("../agentProvisionLock"),
  acquireAgentProvisionLock: mockAcquireAgentProvisionLock,
}));
jest.mock("../kubernetesClusters", () => ({
  assertKubernetesExecutionTargetAvailable: mockAssertKubernetesExecutionTargetAvailable,
  listKubernetesExecutionTargets: jest.fn().mockResolvedValue([]),
}));
jest.mock("../remoteHosts", () => ({
  ...jest.requireActual("../remoteHosts"),
  assertRemoteHostExecutionTargetAvailable: mockAssertRemoteHostExecutionTargetAvailable,
}));
jest.mock("../scheduler", () => ({
  selectNode: jest.fn().mockResolvedValue({ name: "worker-01" }),
}));
jest.mock("../agentVersions", () => ({
  getVersion: mockGetAgentVersion,
  listVersions: jest.fn().mockResolvedValue([]),
  recordVersion: mockRecordAgentVersion,
  recordVersionBestEffort: mockRecordAgentVersionBestEffort,
}));
jest.mock("../containerManager", () => ({
  start: jest.fn().mockResolvedValue({}),
  stop: jest.fn().mockResolvedValue({}),
  restart: jest.fn().mockResolvedValue({}),
  destroy: jest.fn().mockResolvedValue({}),
  persistLifecycleRuntimeAddress: mockPersistLifecycleRuntimeAddress,
  isIgnorableStopError: jest.fn((error) =>
    /already stopped|not running/i.test(String(error?.message || "")),
  ),
  canMutate: jest.fn(
    (agent) =>
      Boolean(agent?.container_id) ||
      ((agent?.backend_type === "k8s" || agent?.deploy_target === "k8s") &&
        Boolean(agent?.container_name || agent?.name || agent?.id)),
  ),
  canDestroy: jest.fn((agent) => Boolean(agent?.container_id || agent?.container_name)),
  isKubernetesAgent: jest.fn(
    (agent) => agent?.backend_type === "k8s" || agent?.deploy_target === "k8s",
  ),
  status: jest.fn().mockResolvedValue({ running: true }),
  stats: mockStats,
}));
jest.mock("../agentHubStore", () => ({
  LISTING_SOURCE_COMMUNITY: "community",
  LISTING_SOURCE_PLATFORM: "platform",
  LISTING_STATUS_PENDING_REVIEW: "pending_review",
  LISTING_STATUS_PUBLISHED: "published",
  LISTING_STATUS_REJECTED: "rejected",
  LISTING_STATUS_REMOVED: "removed",
  LISTING_VISIBILITY_PUBLIC: "public",
  LISTING_SHARE_TARGET_INTERNAL: "internal",
  LISTING_SHARE_TARGET_COMMUNITY: "community",
  LISTING_SHARE_TARGET_BOTH: "both",
  LISTING_LOCAL_VISIBILITY_OWNER: "owner",
  LISTING_LOCAL_VISIBILITY_INTERNAL: "internal",
  CENTRAL_SHARE_STATUS_NOT_SHARED: "not_shared",
  CENTRAL_SHARE_STATUS_QUEUED: "queued",
  CENTRAL_SHARE_STATUS_SUBMITTED: "submitted",
  CENTRAL_SHARE_STATUS_FAILED: "failed",
  listAgentHubLocalListings: jest.fn().mockResolvedValue([]),
  listUserListings: jest.fn().mockResolvedValue([]),
  listCommunityCatalog: jest.fn().mockResolvedValue([]),
  publishSnapshot: jest.fn(),
  getListing: jest.fn(),
  deleteListing: jest.fn(),
  upsertListing: jest.fn(),
  recordInstall: jest.fn(),
  recordDownload: jest.fn(),
  createReport: jest.fn(),
  listAdminListings: jest.fn().mockResolvedValue([]),
  listReports: jest.fn().mockResolvedValue([]),
  resolveReport: jest.fn(),
  setListingStatus: jest.fn(),
  updateCentralShareStatus: jest.fn(),
  getPlatformListingByTemplateKey: jest.fn(),
}));
jest.mock("../agentHubRemote", () => ({
  fetchCatalog: jest.fn().mockResolvedValue({ items: [], hub: { url: "https://nora.test" } }),
  fetchListing: jest.fn(),
  submitListing: jest.fn().mockResolvedValue({ id: "central-listing-1" }),
}));
jest.mock("../snapshots", () => ({
  createSnapshot: jest.fn().mockResolvedValue({ id: "s1", name: "Test", description: "test" }),
  getSnapshot: jest.fn(),
  updateSnapshot: jest.fn(),
}));
jest.mock("../workspaces", () => ({
  listWorkspaces: jest.fn().mockResolvedValue([]),
  createWorkspace: jest.fn(),
  addAgent: jest.fn(),
  getWorkspaceAgents: jest.fn().mockResolvedValue([]),
  listAgentCandidates: jest.fn().mockResolvedValue([]),
  removeAgent: jest.fn(),
  listAccessibleAgents: jest.fn().mockResolvedValue([]),
}));
jest.mock("../integrations", () => ({
  listIntegrations: jest.fn().mockResolvedValue([]),
  connectIntegration: jest.fn(),
  replaceIntegration: jest.fn(),
  removeIntegration: jest.fn(),
  testIntegration: jest.fn(),
  getCatalog: jest.fn().mockResolvedValue([]),
  getCatalogItem: jest.fn(),
  getIntegrationsForSync: jest.fn().mockResolvedValue({}),
  getIntegrationEnvVars: jest.fn().mockResolvedValue({}),
  integrationProviderAffectsLlmAuth: jest.fn().mockReturnValue(false),
  seedCatalog: jest.fn(),
  buildCloneableIntegration: jest.fn((row) => ({
    provider: row.provider,
    catalog_id: row.catalog_id,
    config: { provider: row.provider, redacted: true },
    status: "needs_reconnect",
  })),
}));
jest.mock("../mcpServers", () => ({
  ...jest.requireActual("../mcpServers"),
  getEnabledMcpRuntimeState: jest.fn().mockResolvedValue({
    enabledIds: [],
    entries: [],
    desiredServers: {},
    env: {},
    managedEnvNames: [],
  }),
}));
jest.mock("../monitoring", () => ({
  getMetrics: jest.fn().mockResolvedValue({}),
  logEvent: jest.fn(),
  getRecentEvents: jest.fn().mockResolvedValue([]),
}));
jest.mock("../billing", () => ({
  BILLING_ENABLED: false,
  PLATFORM_MODE: "selfhosted",
  IS_PAAS: false,
  SELFHOSTED_LIMITS: { max_vcpu: 16, max_ram_mb: 32768, max_disk_gb: 500, max_agents: 50 },
  enforceLimits: jest.fn().mockResolvedValue({
    allowed: true,
    subscription: { plan: "selfhosted", vcpu: 2, ram_mb: 2048, disk_gb: 20 },
  }),
  getSubscription: jest.fn().mockResolvedValue({ plan: "selfhosted" }),
  createCheckoutSession: jest.fn(),
  createPortalSession: jest.fn(),
  handleWebhookEvent: jest.fn(),
}));
jest.mock("../llmProviders", () => ({
  getAvailableProviders: jest.fn().mockReturnValue([]),
  listProviders: jest.fn().mockResolvedValue([]),
  addProvider: jest.fn(),
  ensureDemoProvider: mockEnsureDemoProvider,
  providerMutationLockKey: jest.fn((userId) => `nora:llm-providers:${userId}`),
  withProviderStateLock: mockWithProviderStateLock,
  updateProvider: jest.fn(),
  deleteProvider: jest.fn(),
  getProviderKeys: jest.fn().mockResolvedValue([]),
  buildAuthProfiles: jest.fn().mockReturnValue({}),
  PROVIDERS: [],
}));
jest.mock("../channels", () => ({
  listChannels: jest.fn().mockResolvedValue([]),
  createChannel: jest.fn(),
  updateChannel: jest.fn(),
  deleteChannel: jest.fn(),
  testChannel: jest.fn(),
  getMessages: jest.fn().mockResolvedValue([]),
  handleInboundWebhook: jest.fn(),
  buildCloneableChannel: jest.fn((row) => ({
    type: row.type,
    name: row.name,
    config: { type: row.type, redacted: true },
    enabled: false,
  })),
}));
jest.mock("../metrics", () => ({
  parseCostQuery: jest.fn((query = {}) => ({ periodDays: Number(query.period_days) || 30 })),
  getAgentMetrics: jest.fn().mockResolvedValue([]),
  getAgentSummary: jest.fn().mockResolvedValue({}),
  getAgentCost: jest.fn().mockResolvedValue(null),
  getWorkspaceCost: jest.fn().mockResolvedValue({ totalUsd: 0, perAgent: [] }),
  getAccessibleWorkspaceCosts: jest
    .fn()
    .mockResolvedValue({ workspaces: [], uniqueFleetTotalUsd: 0 }),
  recordMetric: jest.fn().mockResolvedValue(),
  recordTokenUsage: jest.fn().mockResolvedValue(),
  recordApiMetric: jest.fn(),
}));
jest.mock("../platformSettings", () => {
  const actual = jest.requireActual("../platformSettings");
  return {
    ...actual,
    getDeploymentDefaults: mockGetDeploymentDefaults,
    getAgentHubSourceApiKey: mockGetAgentHubSourceApiKey,
    getAgentHubSettings: jest.fn().mockResolvedValue({
      defaultShareTarget: "both",
      url: "https://nora.test",
      envUrl: "https://nora.test",
      sourceApiKeyConfigured: true,
      sourceApiKeySource: "database",
      sourceApiKeyMasked: "nora_hub..._key",
    }),
  };
});
jest.mock("../authSync", () => ({
  syncAuthToUserAgents: mockSyncAuthToUserAgents,
  resumeAgentWithProviderAuth: mockResumeAgentWithProviderAuth,
  isProviderAuthStatusHoldReason: (value) =>
    value === "provider_auth_reconciliation_pending" ||
    value === "provider_auth_reconciliation_failed",
  runContainerCommand: mockRunContainerCommand,
}));
jest.mock("../hermesUi", () => ({
  listHermesChannels: mockListHermesChannels,
  saveHermesChannel: mockSaveHermesChannel,
  deleteHermesChannel: mockDeleteHermesChannel,
  testHermesChannel: mockTestHermesChannel,
  readHermesRuntimeSnapshot: mockReadHermesRuntimeSnapshot,
}));
jest.mock("../hermesProfiles", () => ({
  listHermesProfiles: (...a) => mockListHermesProfiles(...a),
  createHermesProfile: (...a) => mockCreateHermesProfile(...a),
  deleteHermesProfile: (...a) => mockDeleteHermesProfile(...a),
  setProfileGatewayState: (...a) => mockSetProfileGatewayState(...a),
  assertProfileExists: (...a) => mockAssertProfileExists(...a),
  assertProfileManagementSupported: (...a) => mockAssertProfileManagementSupported(...a),
}));
jest.mock("../agentMigrations", () => ({
  attachDraftToAgent: mockAttachDraftToAgent,
  buildLiveMigrationManifest: jest.fn(),
  buildMigrationManifestFromAgent: mockBuildMigrationManifestFromAgent,
  createMigrationDraft: jest.fn(),
  deleteOwnedMigrationDraft: jest.fn(),
  getOwnedMigrationDraft: mockGetOwnedMigrationDraft,
  materializeManagedMigrationState: mockMaterializeManagedMigrationState,
  packMigrationBundle: mockPackMigrationBundle,
  parseUploadedMigrationBuffer: jest.fn(),
}));
jest.mock("../agentFiles", () => ({
  createDirectory: mockCreateDirectory,
  deletePath: mockDeletePath,
  downloadPath: mockDownloadPath,
  listFiles: mockListFiles,
  movePath: mockMovePath,
  normalizeRelativePath: mockNormalizeRelativePath,
  readFile: mockReadFile,
  rootsForAgent: mockRootsForAgent,
  writeFile: mockWriteFile,
}));

const app = require("../server");

const userToken = jwt.sign({ id: "user-1", email: "user@nora.test", role: "user" }, JWT_SECRET, {
  expiresIn: "1h",
});
const auth = (req) => req.set("Authorization", `Bearer ${userToken}`);

function hermesAgentRow(overrides = {}) {
  return {
    id: "a-hermes-profiles",
    user_id: "user-1",
    status: "running",
    runtime_family: "hermes",
    backend_type: "docker",
    container_id: "hermes-container",
    runtime_host: "10.0.0.50",
    runtime_port: 8642,
    gateway_token: "hermes-token",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.query.mockReset();
  mockDb.connect.mockReset().mockResolvedValue(mockDbClient);
  mockDbClient.query.mockReset().mockResolvedValue({ rows: [] });
  mockDbClient.release.mockReset();
  mockAcquireAgentProvisionLock.mockReset().mockResolvedValue({
    release: mockAgentProvisionLockRelease,
  });
  mockAgentProvisionLockRelease.mockReset().mockResolvedValue(undefined);
  mockPgClient.mockReset().mockImplementation(() => mockActivationLockClient);
  mockActivationLockClient.connect.mockReset().mockResolvedValue(undefined);
  mockActivationLockClient.query.mockReset().mockResolvedValue({ rows: [] });
  mockActivationLockClient.end.mockReset().mockResolvedValue(undefined);
  mockListHermesChannels.mockReset().mockResolvedValue({
    channels: [],
    availableTypes: [],
    gateway: null,
    directoryUpdatedAt: null,
  });
  mockSaveHermesChannel.mockReset();
  mockDeleteHermesChannel.mockReset().mockResolvedValue({
    channels: [],
    availableTypes: [],
    gateway: null,
    directoryUpdatedAt: null,
  });
  mockTestHermesChannel.mockReset();
  mockListHermesProfiles.mockReset();
  mockCreateHermesProfile.mockReset();
  mockDeleteHermesProfile.mockReset();
  mockSetProfileGatewayState.mockReset();
  mockAssertProfileExists.mockReset().mockResolvedValue(undefined);
  mockAssertProfileManagementSupported.mockReset();
  mockVerifyApiKey.mockReset().mockResolvedValue(null);
  mockAssertRemoteHostExecutionTargetAvailable.mockReset().mockResolvedValue();
  delete process.env.ENABLED_BACKENDS;
  delete process.env.ENABLED_RUNTIME_FAMILIES;
  delete process.env.ENABLED_SANDBOX_PROFILES;
  delete process.env.KUBERNETES_SERVICE_HOST;
  delete process.env.NEXTAUTH_URL;
  require("../billing").IS_PAAS = false;
});

describe("hermes profile routes", () => {
  it("GET /:id/hermes-ui/profiles returns the profile list", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hermesAgentRow()] });
    mockListHermesProfiles.mockResolvedValue({
      profiles: [{ name: "default", isDefault: true, running: true }],
    });

    const res = await auth(request(app).get("/agents/a-hermes-profiles/hermes-ui/profiles"));

    expect(res.status).toBe(200);
    expect(res.body.profiles[0].name).toBe("default");
    expect(mockListHermesProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-profiles" }),
    );
  });

  it("POST /:id/hermes-ui/profiles creates a profile", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hermesAgentRow()] });
    mockCreateHermesProfile.mockResolvedValue({ profile: { name: "coder" } });

    const res = await auth(
      request(app).post("/agents/a-hermes-profiles/hermes-ui/profiles").send({ name: "coder" }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ profile: { name: "coder" } });
    expect(mockCreateHermesProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-profiles" }),
      "coder",
      { cloneFrom: undefined },
    );
  });

  it("POST /:id/hermes-ui/profiles forwards a trimmed cloneFrom", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hermesAgentRow()] });
    mockCreateHermesProfile.mockResolvedValue({ profile: { name: "coder2" } });

    const res = await auth(
      request(app)
        .post("/agents/a-hermes-profiles/hermes-ui/profiles")
        .send({ name: "coder2", cloneFrom: " coder " }),
    );

    expect(res.status).toBe(200);
    expect(mockCreateHermesProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-profiles" }),
      "coder2",
      { cloneFrom: "coder" },
    );
  });

  it("DELETE /:id/hermes-ui/profiles/:name deletes the profile", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hermesAgentRow()] });
    mockDeleteHermesProfile.mockResolvedValue({ profiles: [] });

    const res = await auth(
      request(app).delete("/agents/a-hermes-profiles/hermes-ui/profiles/coder"),
    );

    expect(res.status).toBe(200);
    expect(mockDeleteHermesProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-profiles" }),
      "coder",
    );
  });

  it("POST /:id/hermes-ui/profiles/:name/gateway changes gateway state", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hermesAgentRow()] });
    mockSetProfileGatewayState.mockResolvedValue({ profiles: [] });

    const res = await auth(
      request(app)
        .post("/agents/a-hermes-profiles/hermes-ui/profiles/coder/gateway")
        .send({ action: "restart" }),
    );

    expect(res.status).toBe(200);
    expect(mockSetProfileGatewayState).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-profiles" }),
      "coder",
      "restart",
    );
  });

  it("propagates a statusCode error from the profiles service", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hermesAgentRow()] });
    const error = new Error("Unknown Hermes profile: ghost");
    error.statusCode = 404;
    mockListHermesProfiles.mockRejectedValue(error);

    const res = await auth(request(app).get("/agents/a-hermes-profiles/hermes-ui/profiles"));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Unknown Hermes profile: ghost");
  });
});

describe("hermes-ui channel routes scoped by ?profile=", () => {
  it("GET channels defaults to the default profile", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hermesAgentRow()] });

    const res = await auth(request(app).get("/agents/a-hermes-profiles/hermes-ui/channels"));

    expect(res.status).toBe(200);
    expect(mockAssertProfileExists).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-profiles" }),
      "default",
    );
    expect(mockListHermesChannels).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-profiles" }),
      { profile: "default" },
    );
  });

  it("GET channels validates and threads ?profile=coder", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hermesAgentRow()] });

    const res = await auth(
      request(app).get("/agents/a-hermes-profiles/hermes-ui/channels?profile=coder"),
    );

    expect(res.status).toBe(200);
    expect(mockAssertProfileExists).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-profiles" }),
      "coder",
    );
    expect(mockListHermesChannels).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-profiles" }),
      { profile: "coder" },
    );
  });

  it("rejects channel access for an unknown profile", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hermesAgentRow()] });
    const error = new Error("Unknown Hermes profile: ghost");
    error.statusCode = 404;
    mockAssertProfileExists.mockRejectedValueOnce(error);

    const res = await auth(
      request(app).get("/agents/a-hermes-profiles/hermes-ui/channels?profile=ghost"),
    );

    expect(res.status).toBe(404);
    expect(mockListHermesChannels).not.toHaveBeenCalled();
  });

  it("POST channels creates in the requested profile", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hermesAgentRow()] });
    mockSaveHermesChannel.mockResolvedValue({ channels: [], availableTypes: [] });

    const res = await auth(
      request(app)
        .post("/agents/a-hermes-profiles/hermes-ui/channels?profile=coder")
        .send({ type: "telegram", token: "t-1" }),
    );

    expect(res.status).toBe(200);
    expect(mockSaveHermesChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-profiles" }),
      "telegram",
      { token: "t-1" },
      { create: true, profile: "coder" },
    );
  });

  it("PATCH channels updates in the requested profile", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hermesAgentRow()] });
    mockSaveHermesChannel.mockResolvedValue({ channels: [], availableTypes: [] });

    const res = await auth(
      request(app)
        .patch("/agents/a-hermes-profiles/hermes-ui/channels/telegram?profile=coder")
        .send({ token: "t-2" }),
    );

    expect(res.status).toBe(200);
    expect(mockSaveHermesChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-profiles" }),
      "telegram",
      { token: "t-2" },
      { profile: "coder" },
    );
  });

  it("DELETE channel removes from the requested profile", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hermesAgentRow()] });

    const res = await auth(
      request(app).delete("/agents/a-hermes-profiles/hermes-ui/channels/telegram?profile=coder"),
    );

    expect(res.status).toBe(200);
    expect(mockDeleteHermesChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-profiles" }),
      "telegram",
      { profile: "coder" },
    );
  });

  it("POST channel test runs against the requested profile", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [hermesAgentRow()] });
    mockTestHermesChannel.mockResolvedValue({ ok: true });

    const res = await auth(
      request(app).post(
        "/agents/a-hermes-profiles/hermes-ui/channels/telegram/test?profile=coder",
      ),
    );

    expect(res.status).toBe(200);
    expect(mockTestHermesChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-hermes-profiles" }),
      "telegram",
      { profile: "coder" },
    );
  });
});
