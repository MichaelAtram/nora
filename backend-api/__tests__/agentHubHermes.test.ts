// @ts-nocheck
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mockDb = { query: jest.fn() };
const mockRunContainerCommand = jest.fn();
const mockIsRemoteDockerAgent = jest.fn();
const mockAssertRemoteHostAgentUse = jest.fn();
const mockToPublicRemoteHostAuthorizationError = jest.fn();
const mockAssertRemoteHostExecutionTargetAvailable = jest.fn();
const mockRuntimeAuthHeaders = jest.fn();
const mockBuildHermesTemplatePayloadFromAgent = jest.fn();
const mockBuildHermesBundleMetadata = jest.fn();
const mockCreateSnapshot = jest.fn();
const mockGetSnapshot = jest.fn();
const mockUpsertListing = jest.fn();
const mockGetListing = jest.fn();
const mockGetAgentHubSettings = jest.fn();
const mockLogEvent = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("../authSync", () => ({
  runContainerCommand: mockRunContainerCommand,
}));
jest.mock("../containerManager", () => ({
  restart: jest.fn(),
  isKubernetesAgent: jest.fn(),
  updateEnv: jest.fn(),
  persistLifecycleRuntimeAddress: jest.fn(),
}));
jest.mock("../healthChecks", () => ({
  waitForAgentReadiness: jest.fn(),
}));
jest.mock("../remoteHosts", () => ({
  isRemoteDockerAgent: (...args) => mockIsRemoteDockerAgent(...args),
  assertRemoteHostAgentUse: (...args) => mockAssertRemoteHostAgentUse(...args),
  toPublicRemoteHostAuthorizationError: (...args) =>
    mockToPublicRemoteHostAuthorizationError(...args),
  assertRemoteHostExecutionTargetAvailable: (...args) =>
    mockAssertRemoteHostExecutionTargetAvailable(...args),
}));
jest.mock("../runtimeAuth", () => ({
  runtimeAuthHeaders: mockRuntimeAuthHeaders,
}));
jest.mock("../hermesTemplateExport", () => ({
  buildHermesTemplatePayloadFromAgent: mockBuildHermesTemplatePayloadFromAgent,
  buildHermesBundleMetadata: mockBuildHermesBundleMetadata,
}));
jest.mock("../redisQueue", () => ({
  addDeploymentJob: jest.fn(),
}));
jest.mock("../billing", () => ({
  IS_PAAS: false,
  SELFHOSTED_LIMITS: { max_vcpu: 8, max_ram_mb: 16384, max_disk_gb: 200 },
  enforceLimits: jest.fn(),
}));
jest.mock("../agentHubStore", () => ({
  LISTING_SOURCE_PLATFORM: "platform",
  LISTING_SOURCE_COMMUNITY: "community",
  LISTING_STATUS_PUBLISHED: "published",
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
  getListing: (...args) => mockGetListing(...args),
  upsertListing: (...args) => mockUpsertListing(...args),
  updateCentralShareStatus: jest.fn(),
  listAgentHubLocalListings: jest.fn(),
  listUserListings: jest.fn(),
  listCommunityCatalog: jest.fn(),
  recordInstall: jest.fn(),
  recordDownload: jest.fn(),
  createReport: jest.fn(),
}));
jest.mock("../agentHubApiKeys", () => ({
  listApiKeys: jest.fn(),
  createApiKey: jest.fn(),
  revokeApiKey: jest.fn(),
}));
jest.mock("../agentHubRemote", () => ({
  fetchCatalog: jest.fn(),
  fetchListing: jest.fn(),
  submitListing: jest.fn(),
}));
jest.mock("../platformSettings", () => ({
  getAgentHubSettings: (...args) => mockGetAgentHubSettings(...args),
  getAgentHubSourceApiKey: jest.fn(),
}));
jest.mock("../snapshots", () => ({
  createSnapshot: (...args) => mockCreateSnapshot(...args),
  getSnapshot: (...args) => mockGetSnapshot(...args),
  updateSnapshot: jest.fn(),
}));
jest.mock("../scheduler", () => ({
  selectNode: jest.fn(),
}));
jest.mock("../monitoring", () => ({
  logEvent: (...args) => mockLogEvent(...args),
}));
jest.mock("../kubernetesClusters", () => ({
  assertKubernetesExecutionTargetAvailable: jest.fn(),
}));
jest.mock("../middleware/auth", () => ({
  requireSession: (req, _res, next) => {
    req.user = { id: "user-1", email: "user@example.com" };
    next();
  },
}));
jest.mock("../middleware/errorHandler", () => ({
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
}));
jest.mock("../auditLog", () => ({
  buildAgentContext: jest.fn(() => ({})),
  buildAuditMetadata: jest.fn(() => ({})),
  buildListingContext: jest.fn(() => ({})),
  buildReportContext: jest.fn(() => ({})),
  createMutationFailureAuditMiddleware: () => (_req, _res, next) => next(),
}));

const express = require("express");
const request = require("supertest");
const router = require("../routes/agentHub");
const { summarizeTemplatePayload } = require("../agentPayloads");
// The route tests above exercise the mocked export module; the capture unit
// tests below need the real implementation with the same mocked transports.
const hermesTemplateExport = jest.requireActual("../hermesTemplateExport");

const ORIGINAL_ENABLED_RUNTIME_FAMILIES = process.env.ENABLED_RUNTIME_FAMILIES;

function encode(content) {
  return Buffer.from(content, "utf8").toString("base64");
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ error: error.message });
  });
  return app;
}

function hermesAgentRow(overrides = {}) {
  return {
    id: "agent-h1",
    user_id: "user-1",
    name: "Hermes Helper",
    status: "running",
    container_id: "container-1",
    runtime_family: "hermes",
    backend_type: "docker",
    deploy_target: "docker",
    execution_target_id: "docker",
    sandbox_type: "standard",
    sandbox_profile: "standard",
    runtime_host: null,
    vcpu: 2,
    ram_mb: 2048,
    disk_gb: 20,
    image: "nousresearch/hermes-agent:latest",
    hermes_skills: [
      {
        source: "hermes-hub",
        ref: "official/security/1password",
        name: "1password",
        installMode: "cli",
        installedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    template_payload: null,
    ...overrides,
  };
}

function openclawAgentRow(overrides = {}) {
  return {
    id: "agent-o1",
    user_id: "user-1",
    name: "OpenClaw Buddy",
    status: "stopped",
    container_id: null,
    runtime_family: "openclaw",
    backend_type: "docker",
    deploy_target: "docker",
    execution_target_id: "docker",
    sandbox_type: "standard",
    sandbox_profile: "standard",
    runtime_host: null,
    vcpu: 2,
    ram_mb: 2048,
    disk_gb: 20,
    image: "openclaw:latest",
    template_payload: {
      files: [{ path: "CUSTOM.md", contentBase64: encode("stored template") }],
    },
    ...overrides,
  };
}

function hermesCapturePayload(files = null) {
  return {
    version: 1,
    files: files || [{ path: "notes.md", contentBase64: encode("# Notes"), mode: 0o644 }],
    memoryFiles: [],
    wiring: { channels: [], integrations: [] },
    metadata: {
      runtimeFamily: "hermes",
      source: "hermes-live-capture",
      capturedAt: "2026-07-30T00:00:00.000Z",
    },
  };
}

const HERMES_BUNDLE_METADATA = Object.freeze({
  runtimeFamily: "hermes",
  hermesSkills: [
    {
      source: "hermes-hub",
      ref: "official/security/1password",
      name: "1password",
      installMode: "cli",
      installedAt: "2026-07-01T00:00:00.000Z",
    },
  ],
  hermesModelConfig: { provider: "nous", defaultModel: "hermes-4-405b", baseUrl: "" },
});

function primeAgentQuery(agent) {
  mockDb.query.mockImplementation(async (sql) => {
    if (String(sql).includes("FROM agents WHERE id = $1 AND user_id = $2")) {
      return { rows: agent ? [agent] : [] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENABLED_RUNTIME_FAMILIES = "openclaw,hermes";
  mockIsRemoteDockerAgent.mockImplementation((agent) =>
    [agent?.deploy_target, agent?.backend_type, agent?.execution_target_id].some((value) =>
      String(value || "")
        .toLowerCase()
        .startsWith("remote"),
    ),
  );
  mockToPublicRemoteHostAuthorizationError.mockImplementation((error) => error);
  mockAssertRemoteHostAgentUse.mockResolvedValue({ id: "shared-host" });
  mockRuntimeAuthHeaders.mockResolvedValue({});
  mockGetAgentHubSettings.mockResolvedValue({ defaultShareTarget: "internal" });
  mockCreateSnapshot.mockResolvedValue({
    id: "snapshot-1",
    name: "Snapshot",
    kind: "community-template",
    template_key: null,
  });
  mockUpsertListing.mockResolvedValue({
    id: "listing-1",
    name: "Listing",
    central_share_status: "not_shared",
  });
  mockGetListing.mockResolvedValue({
    id: "listing-1",
    name: "Listing",
    central_share_status: "not_shared",
  });
  mockLogEvent.mockResolvedValue(undefined);
});

afterAll(() => {
  if (ORIGINAL_ENABLED_RUNTIME_FAMILIES === undefined) {
    delete process.env.ENABLED_RUNTIME_FAMILIES;
  } else {
    process.env.ENABLED_RUNTIME_FAMILIES = ORIGINAL_ENABLED_RUNTIME_FAMILIES;
  }
});

describe("POST /share runtime-family guard", () => {
  it("rejects sharing an agent whose family is not enabled on this instance", async () => {
    process.env.ENABLED_RUNTIME_FAMILIES = "openclaw";
    primeAgentQuery(hermesAgentRow());

    const res = await request(buildApp()).post("/share").send({ agentId: "agent-h1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not enabled/i);
    expect(mockBuildHermesTemplatePayloadFromAgent).not.toHaveBeenCalled();
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
  });

  it("rejects sharing an agent with an unknown runtime family", async () => {
    primeAgentQuery(hermesAgentRow({ runtime_family: "quantumclaw" }));

    const res = await request(buildApp()).post("/share").send({ agentId: "agent-h1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be published/i);
    expect(mockBuildHermesTemplatePayloadFromAgent).not.toHaveBeenCalled();
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["stopped status", { status: "stopped" }],
    ["missing container id", { container_id: null }],
  ])("returns 409 for a Hermes agent with %s", async (_label, overrides) => {
    primeAgentQuery(hermesAgentRow(overrides));

    const res = await request(buildApp()).post("/share").send({ agentId: "agent-h1" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/live agent workspace/i);
    expect(mockBuildHermesTemplatePayloadFromAgent).not.toHaveBeenCalled();
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
  });
});

describe("POST /share hermes publish flow", () => {
  it("captures the live workspace, merges bundle metadata, and persists the hermes family", async () => {
    const agent = hermesAgentRow();
    primeAgentQuery(agent);
    mockBuildHermesTemplatePayloadFromAgent.mockResolvedValue(hermesCapturePayload());
    mockBuildHermesBundleMetadata.mockResolvedValue({ ...HERMES_BUNDLE_METADATA });

    const res = await request(buildApp())
      .post("/share")
      .send({ agentId: "agent-h1", name: "Hermes Bundle" });

    expect(res.status).toBe(200);
    expect(mockBuildHermesTemplatePayloadFromAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-h1" }),
    );
    expect(mockBuildHermesBundleMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-h1" }),
    );

    const [, , , snapshotConfig] = mockCreateSnapshot.mock.calls[0];
    expect(snapshotConfig.defaults.runtime_family).toBe("hermes");
    expect(snapshotConfig.templatePayload.metadata).toEqual(
      expect.objectContaining({
        runtimeFamily: "hermes",
        hermesSkills: HERMES_BUNDLE_METADATA.hermesSkills,
        hermesModelConfig: HERMES_BUNDLE_METADATA.hermesModelConfig,
      }),
    );
    // The captured workspace must ship as-is: no synthesized OpenClaw core files.
    expect(snapshotConfig.templatePayload.files.map((entry) => entry.path)).toEqual(["notes.md"]);

    expect(mockUpsertListing).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeFamily: "hermes" }),
    );
  });

  it("keeps the secrets scan gating hermes shares", async () => {
    primeAgentQuery(hermesAgentRow());
    mockBuildHermesTemplatePayloadFromAgent.mockResolvedValue(
      hermesCapturePayload([
        {
          path: "notes.md",
          contentBase64: encode(`OPENAI_API_KEY=sk-${"A1b2C3d4E5".repeat(3)}`),
          mode: 0o644,
        },
      ]),
    );
    mockBuildHermesBundleMetadata.mockResolvedValue({ ...HERMES_BUNDLE_METADATA });

    const res = await request(buildApp()).post("/share").send({ agentId: "agent-h1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/secrets/i);
    expect(res.body.issues.length).toBeGreaterThan(0);
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
    expect(mockUpsertListing).not.toHaveBeenCalled();
  });

  it("surfaces capture failures as a 409 without creating a listing", async () => {
    primeAgentQuery(hermesAgentRow());
    mockBuildHermesTemplatePayloadFromAgent.mockRejectedValue(
      new Error("Container exec unavailable"),
    );

    const res = await request(buildApp()).post("/share").send({ agentId: "agent-h1" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Container exec unavailable");
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
  });
});

describe("POST /share openclaw publish flow (unchanged)", () => {
  it("still publishes from the stored payload with synthesized core files", async () => {
    primeAgentQuery(openclawAgentRow());

    const res = await request(buildApp())
      .post("/share")
      .send({ agentId: "agent-o1", name: "OpenClaw Template" });

    expect(res.status).toBe(200);
    expect(mockBuildHermesTemplatePayloadFromAgent).not.toHaveBeenCalled();
    expect(mockBuildHermesBundleMetadata).not.toHaveBeenCalled();

    const [, , , snapshotConfig] = mockCreateSnapshot.mock.calls[0];
    expect(snapshotConfig.defaults.runtime_family).toBe("openclaw");
    const paths = snapshotConfig.templatePayload.files.map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining(["CUSTOM.md", "AGENTS.md", "SOUL.md"]));

    expect(mockUpsertListing).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeFamily: "openclaw" }),
    );
  });
});

describe("hermesTemplateExport workspace capture", () => {
  function captureResult(payload) {
    return {
      exitCode: 0,
      output: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    };
  }

  function decodeHermesHelperScript(command) {
    const match = String(command || "").match(/base64\.b64decode\("([^"]+)"\)\.decode\('utf-8'\)/);
    if (!match) return "";
    return Buffer.from(match[1], "base64").toString("utf8");
  }

  it("builds a capture command that walks the workspace with the documented exclusions", () => {
    const command = hermesTemplateExport.buildHermesWorkspaceCaptureCommand();
    const script = decodeHermesHelperScript(command);

    expect(script).toContain('"/opt/data/workspace"');
    expect(script).toContain('excluded_dir_names = {"integrations"}');
    expect(script).toContain('excluded_file_names = {"NORA_INTEGRATIONS.md"}');
    expect(script).toContain('name.startswith("integrations") and name.endswith(".json")');
    expect(script).toContain('name.startswith(".")');
    expect(script).toContain("max_file_bytes = 1048576");
    expect(script).toContain("max_files = 200");
  });

  it("normalizes a live capture into a hermes payload without core-file synthesis", async () => {
    mockRunContainerCommand.mockResolvedValue(
      captureResult({
        files: [
          { path: "scripts/run.sh", contentBase64: encode("echo hi") },
          { path: "notes.md", contentBase64: encode("# Notes") },
        ],
        truncated: false,
        skippedFileCount: 0,
        skippedFiles: [],
      }),
    );

    const payload =
      await hermesTemplateExport.buildHermesTemplatePayloadFromAgent(hermesAgentRow());

    expect(mockRunContainerCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-h1" }),
      expect.stringContaining("PY"),
      { timeout: 120000 },
    );
    expect(payload.files.map((entry) => entry.path)).toEqual(["notes.md", "scripts/run.sh"]);
    expect(payload.metadata).toEqual(
      expect.objectContaining({ runtimeFamily: "hermes", source: "hermes-live-capture" }),
    );
    expect(payload.metadata.captureTruncated).toBeUndefined();

    const summary = summarizeTemplatePayload(payload);
    expect(summary.runtimeFamily).toBe("hermes");
    expect(summary.requiredCoreCount).toBe(0);
    expect(summary.presentRequiredCoreCount).toBe(0);
    expect(summary.missingRequiredCoreFiles).toEqual([]);
    expect(summary.coreFiles).toEqual([]);
    expect(summary.files.map((file) => file.path)).toEqual(["notes.md", "scripts/run.sh"]);
  });

  it("flags truncated captures in metadata and warns", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockRunContainerCommand.mockResolvedValue(
      captureResult({
        files: [{ path: "notes.md", contentBase64: encode("# Notes") }],
        truncated: true,
        skippedFileCount: 2,
        skippedFiles: ["big.bin", "video.mp4"],
      }),
    );

    try {
      const payload =
        await hermesTemplateExport.buildHermesTemplatePayloadFromAgent(hermesAgentRow());

      expect(payload.metadata.captureTruncated).toBe(true);
      expect(payload.metadata.captureSkippedFileCount).toBe(2);
      expect(payload.metadata.captureSkippedFiles).toEqual(["big.bin", "video.mp4"]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("skipped content"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects empty capture output", async () => {
    mockRunContainerCommand.mockResolvedValue({ exitCode: 0, output: "  " });

    await expect(
      hermesTemplateExport.buildHermesTemplatePayloadFromAgent(hermesAgentRow()),
    ).rejects.toThrow(/empty output/i);
  });

  it("rejects non-JSON capture output with a diagnostic error", async () => {
    mockRunContainerCommand.mockResolvedValue({ exitCode: 0, output: "not-base64-json" });

    await expect(
      hermesTemplateExport.buildHermesTemplatePayloadFromAgent(hermesAgentRow()),
    ).rejects.toThrow(/Unexpected Hermes workspace capture output/i);
  });
});

describe("hermesTemplateExport bundle metadata", () => {
  it("restricts model config to provider/defaultModel/baseUrl even when the row has keys", async () => {
    mockDb.query.mockResolvedValue({
      rows: [
        {
          model_config: JSON.stringify({
            provider: "openrouter",
            defaultModel: "hermes-4",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "sk-secret-camel-000000",
            api_key: "sk-secret-snake-000000",
          }),
        },
      ],
    });

    const metadata = await hermesTemplateExport.buildHermesBundleMetadata(hermesAgentRow());

    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("hermes_runtime_state"), [
      "agent-h1",
    ]);
    expect(metadata.runtimeFamily).toBe("hermes");
    expect(metadata.hermesModelConfig).toEqual({
      provider: "openrouter",
      defaultModel: "hermes-4",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(JSON.stringify(metadata)).not.toContain("sk-secret");
  });

  it("re-normalizes saved skills, dropping reserved and duplicate entries", async () => {
    mockDb.query.mockResolvedValue({ rows: [] });

    const metadata = await hermesTemplateExport.buildHermesBundleMetadata(
      hermesAgentRow({
        hermes_skills: [
          {
            source: "hermes-hub",
            ref: "official/security/1password",
            name: "1password",
            installMode: "cli",
            installedAt: "2026-07-01T00:00:00.000Z",
          },
          {
            source: "hermes-hub",
            ref: "official/security/1password",
            name: "1password",
            installMode: "cli",
            installedAt: "2026-07-02T00:00:00.000Z",
          },
          { source: "hermes-hub", ref: "internal", name: "nora-integrations" },
          { source: "hermes-hub", ref: "bad", name: "../escape" },
        ],
      }),
    );

    expect(metadata.hermesSkills).toEqual([
      {
        source: "hermes-hub",
        ref: "official/security/1password",
        name: "1password",
        installMode: "cli",
        installedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
  });

  it("returns empty model config when no hermes_runtime_state row exists", async () => {
    mockDb.query.mockResolvedValue({ rows: [] });

    const metadata = await hermesTemplateExport.buildHermesBundleMetadata(
      hermesAgentRow({ hermes_skills: [] }),
    );

    expect(metadata.hermesModelConfig).toEqual({ provider: "", defaultModel: "", baseUrl: "" });
    expect(metadata.hermesSkills).toEqual([]);
  });
});
