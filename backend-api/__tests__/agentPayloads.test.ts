// @ts-nocheck
const mockRuntimeAuthHeaders = jest.fn();
const mockAssertRemoteHostAgentUse = jest.fn();
const mockIsRemoteDockerAgent = jest.fn();
const mockToPublicRemoteHostAuthorizationError = jest.fn();

jest.mock("../runtimeAuth", () => ({
  runtimeAuthHeaders: mockRuntimeAuthHeaders,
}));
jest.mock("../remoteHosts", () => ({
  assertRemoteHostAgentUse: (...args) => mockAssertRemoteHostAgentUse(...args),
  isRemoteDockerAgent: (...args) => mockIsRemoteDockerAgent(...args),
  toPublicRemoteHostAuthorizationError: (...args) =>
    mockToPublicRemoteHostAuthorizationError(...args),
}));

const {
  buildTemplatePayloadFromAgent,
  ensureCoreTemplateFiles,
  extractTemplateDefaultsFromSnapshot,
  extractTemplatePayloadFromSnapshot,
  serializeAgent,
  summarizeTemplatePayload,
} = require("../agentPayloads");
const { buildAgentHubTemplateUpdate } = require("../agentHubTemplateEdits");

beforeEach(() => {
  mockRuntimeAuthHeaders.mockReset().mockResolvedValue({ Authorization: "Bearer token" });
  mockAssertRemoteHostAgentUse.mockReset().mockResolvedValue({ id: "shared-host" });
  mockIsRemoteDockerAgent.mockReset().mockImplementation((agent) =>
    [agent?.deploy_target, agent?.backend_type, agent?.execution_target_id].some((value) =>
      String(value || "")
        .toLowerCase()
        .startsWith("remote"),
    ),
  );
  mockToPublicRemoteHostAuthorizationError.mockReset().mockImplementation((error) => error);
});

describe("serializeAgent", () => {
  it("maps network_policy_status to networkPolicyStatus", () => {
    const serialized = serializeAgent({
      id: "agent-1",
      runtime_family: "openclaw",
      deploy_target: "k8s",
      execution_target_id: "k8s:test-cluster",
      sandbox_profile: "standard",
      network_policy_status: {
        policyStatus: "supported",
        policyBundleAttempted: true,
        policyBundleApplied: true,
        policyIssue: null,
      },
    });

    expect(serialized.networkPolicyStatus).toEqual({
      policyStatus: "supported",
      policyBundleAttempted: true,
      policyBundleApplied: true,
      policyIssue: null,
    });
    expect(serialized).not.toHaveProperty("network_policy_status");
  });

  it("keeps networkPolicyStatus null when no policy state was persisted", () => {
    const serialized = serializeAgent({
      id: "agent-2",
      runtime_family: "openclaw",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
      network_policy_status: null,
    });

    expect(serialized.networkPolicyStatus).toBeNull();
  });
});

describe("Agent Hub template deploy targets", () => {
  it("rejects unknown canonical template targets instead of defaulting installs to Docker", () => {
    expect(() =>
      extractTemplateDefaultsFromSnapshot({
        config: {
          defaults: {
            deploy_target: "moon",
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_DEPLOY_TARGET" }));
  });

  it("rejects unknown template execution targets instead of defaulting installs to Docker", () => {
    expect(() =>
      extractTemplateDefaultsFromSnapshot({
        config: {
          defaults: {
            execution_target_id: "moon",
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_DEPLOY_TARGET" }));
  });

  it("keeps legacy NemoClaw backend metadata on the Docker compatibility path", () => {
    expect(
      extractTemplateDefaultsFromSnapshot({
        config: {
          defaults: {
            backend: "nemoclaw",
            sandbox: "nemoclaw",
          },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        backend: null,
        executionTargetId: null,
        sandbox: "nemoclaw",
      }),
    );
  });

  it.each(["sandbox_profile", "sandboxProfile", "sandbox"])(
    "rejects unknown template %s values instead of downgrading to the standard sandbox",
    (field) => {
      expect(() =>
        extractTemplateDefaultsFromSnapshot({
          config: {
            defaults: {
              [field]: "nemoclaw-typo",
            },
          },
        }),
      ).toThrow(expect.objectContaining({ code: "UNKNOWN_SANDBOX_PROFILE", statusCode: 400 }));
    },
  );

  it("rejects unknown backend edits instead of retaining a deployable fallback", () => {
    expect(() =>
      buildAgentHubTemplateUpdate(
        {
          name: "Template",
          kind: "community-template",
          config: {
            defaults: {
              backend: "docker",
              sandbox: "standard",
            },
          },
        },
        { name: "Template", source_type: "community" },
        { backend: "moon" },
      ),
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_DEPLOY_TARGET" }));
  });

  it("rejects unknown sandbox edits instead of retaining a deployable fallback", () => {
    expect(() =>
      buildAgentHubTemplateUpdate(
        {
          name: "Template",
          kind: "community-template",
          config: {
            defaults: {
              backend: "docker",
              sandbox: "standard",
            },
          },
        },
        { name: "Template", source_type: "community" },
        { sandbox: "nemoclaw-typo" },
      ),
    ).toThrow(expect.objectContaining({ code: "UNKNOWN_SANDBOX_PROFILE", statusCode: 400 }));
  });
});

describe("Agent Hub template runtime family", () => {
  it("defaults runtimeFamily to openclaw for snapshots captured before the field existed", () => {
    expect(
      extractTemplateDefaultsFromSnapshot({
        config: {
          defaults: {
            deploy_target: "docker",
          },
        },
      }),
    ).toEqual(expect.objectContaining({ runtimeFamily: "openclaw" }));
  });

  it("defaults runtimeFamily to openclaw when the snapshot has no defaults at all", () => {
    expect(extractTemplateDefaultsFromSnapshot({ config: {} })).toEqual(
      expect.objectContaining({ runtimeFamily: "openclaw" }),
    );
  });

  it("surfaces a stored runtime_family from snapshot defaults", () => {
    expect(
      extractTemplateDefaultsFromSnapshot({
        config: {
          defaults: {
            runtime_family: "hermes",
          },
        },
      }),
    ).toEqual(expect.objectContaining({ runtimeFamily: "hermes" }));
  });

  it("accepts the camelCase runtimeFamily alias", () => {
    expect(
      extractTemplateDefaultsFromSnapshot({
        config: {
          defaults: {
            runtimeFamily: "hermes",
          },
        },
      }),
    ).toEqual(expect.objectContaining({ runtimeFamily: "hermes" }));
  });

  it("collapses unknown runtime families to openclaw", () => {
    expect(
      extractTemplateDefaultsFromSnapshot({
        config: {
          defaults: {
            runtime_family: "quantumclaw",
          },
        },
      }),
    ).toEqual(expect.objectContaining({ runtimeFamily: "openclaw" }));
  });
});

const OPENCLAW_REQUIRED_PATHS = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "MEMORY.md",
];

describe("ensureCoreTemplateFiles family awareness", () => {
  const hermesFiles = [
    { path: "notes/plan.md", content: "# Plan" },
    { path: "scripts/run.sh", content: "echo hi" },
  ];

  it("keeps synthesizing the seven required OpenClaw files by default", () => {
    const payload = ensureCoreTemplateFiles({ files: [] }, { name: "Pinned Behavior" });

    const paths = payload.files.map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining(OPENCLAW_REQUIRED_PATHS));
    expect(paths).not.toContain("BOOTSTRAP.md");
  });

  it("skips synthesis for an explicit non-OpenClaw runtime family", () => {
    const payload = ensureCoreTemplateFiles({ files: hermesFiles }, { runtimeFamily: "hermes" });

    expect(payload.files.map((entry) => entry.path)).toEqual(["notes/plan.md", "scripts/run.sh"]);
  });

  it("skips synthesis when the payload metadata carries runtimeFamily hermes", () => {
    const payload = ensureCoreTemplateFiles({
      files: hermesFiles,
      metadata: { runtimeFamily: "hermes" },
    });

    expect(payload.files.map((entry) => entry.path)).toEqual(["notes/plan.md", "scripts/run.sh"]);
    expect(payload.metadata).toEqual({ runtimeFamily: "hermes" });
  });

  it("collapses unknown carried families to OpenClaw synthesis", () => {
    const payload = ensureCoreTemplateFiles({
      files: [],
      metadata: { runtimeFamily: "quantumclaw" },
    });

    expect(payload.files.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(OPENCLAW_REQUIRED_PATHS),
    );
  });

  it("lets an explicit openclaw override beat a hermes metadata carrier", () => {
    const payload = ensureCoreTemplateFiles(
      { files: [], metadata: { runtimeFamily: "hermes" } },
      { runtimeFamily: "openclaw" },
    );

    expect(payload.files.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(OPENCLAW_REQUIRED_PATHS),
    );
  });
});

describe("summarizeTemplatePayload family awareness", () => {
  it("pins the OpenClaw summary contract: requiredCoreCount 7 and synthesized core files", () => {
    const summary = summarizeTemplatePayload({ files: [] }, { context: { name: "Pinned" } });

    expect(summary.runtimeFamily).toBe("openclaw");
    expect(summary.requiredCoreCount).toBe(7);
    expect(summary.presentRequiredCoreCount).toBe(7);
    expect(summary.missingRequiredCoreFiles).toEqual([]);
    expect(summary.coreFiles).toHaveLength(8);
    expect(summary.fileCount).toBe(7);
    expect(summary.extraFilesCount).toBe(0);
    expect(summary.hasBootstrap).toBe(false);
  });

  it("reports zero core-file requirements for hermes payloads without fabricating files", () => {
    const summary = summarizeTemplatePayload({
      files: [{ path: "notes.md", content: "hello" }],
      metadata: { runtimeFamily: "hermes" },
    });

    expect(summary.runtimeFamily).toBe("hermes");
    expect(summary.requiredCoreCount).toBe(0);
    expect(summary.presentRequiredCoreCount).toBe(0);
    expect(summary.missingRequiredCoreFiles).toEqual([]);
    expect(summary.coreFiles).toEqual([]);
    expect(summary.fileCount).toBe(1);
    expect(summary.extraFilesCount).toBe(1);
    expect(summary.files.map((file) => file.path)).toEqual(["notes.md"]);
    expect(summary.files[0].isCore).toBe(false);
    expect(summary.files[0].requiredCore).toBe(false);
  });

  it("prefers the explicit runtimeFamily option over the metadata carrier", () => {
    const summary = summarizeTemplatePayload(
      { files: [], metadata: { runtimeFamily: "openclaw" } },
      { runtimeFamily: "hermes" },
    );

    expect(summary.runtimeFamily).toBe("hermes");
    expect(summary.requiredCoreCount).toBe(0);
    expect(summary.fileCount).toBe(0);
  });
});

describe("extractTemplatePayloadFromSnapshot family awareness", () => {
  it("does not fabricate OpenClaw core files for hermes snapshots", () => {
    const payload = extractTemplatePayloadFromSnapshot({
      name: "Hermes Listing",
      kind: "community-template",
      config: {
        defaults: { runtime_family: "hermes" },
        templatePayload: { files: [{ path: "notes.md", content: "hi" }] },
      },
    });

    expect(payload.files.map((entry) => entry.path)).toEqual(["notes.md"]);
  });

  it("keeps synthesizing core files for openclaw snapshots", () => {
    const payload = extractTemplatePayloadFromSnapshot({
      name: "OpenClaw Listing",
      kind: "community-template",
      config: {
        defaults: { runtime_family: "openclaw" },
        templatePayload: { files: [] },
      },
    });

    expect(payload.files.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([...OPENCLAW_REQUIRED_PATHS, "BOOTSTRAP.md"]),
    );
  });
});

describe("buildTemplatePayloadFromAgent capture authorization", () => {
  it.each([
    "REMOTE_HOST_ACCESS_REVOKED",
    "REMOTE_HOST_RETEST_REQUIRED",
    "REMOTE_HOST_AUTH_CHECK_FAILED",
  ])("does not fall back before fetch when runtime authorization fails with %s", async (code) => {
    const authorizationError = Object.assign(new Error("remote host authorization failed"), {
      code,
    });
    mockRuntimeAuthHeaders.mockRejectedValueOnce(authorizationError);
    const fetchSpy = jest.spyOn(global, "fetch");

    try {
      await expect(
        buildTemplatePayloadFromAgent(
          {
            id: "remote-agent",
            name: "Remote agent",
            runtime_family: "openclaw",
            deploy_target: "remote-docker",
            execution_target_id: "remote:shared-host",
            runtime_host: "10.0.0.12",
            runtime_port: 9090,
            template_payload: {
              files: [
                {
                  path: "STALE.md",
                  contentBase64: Buffer.from("must not be accepted").toString("base64"),
                },
              ],
            },
          },
          "files_only",
        ),
      ).rejects.toBe(authorizationError);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(mockRuntimeAuthHeaders).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps stored-template fallback for a stopped non-remote agent", async () => {
    const payload = await buildTemplatePayloadFromAgent(
      {
        id: "stopped-local-agent",
        name: "Stopped local agent",
        status: "stopped",
        runtime_family: "openclaw",
        deploy_target: "docker",
        execution_target_id: "docker",
        runtime_host: null,
        template_payload: {
          metadata: {
            source: "demo-activation",
            activation: "local-docker-demo-v1",
          },
          files: [
            {
              path: "CUSTOM.md",
              contentBase64: Buffer.from("stored template").toString("base64"),
            },
          ],
        },
      },
      "files_only",
    );

    expect(payload.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "CUSTOM.md" })]),
    );
    expect(payload.metadata).toEqual({ source: "demo-activation" });
    expect(mockRuntimeAuthHeaders).not.toHaveBeenCalled();
    expect(mockAssertRemoteHostAgentUse).not.toHaveBeenCalled();
  });

  it("aborts a long Remote Docker export when its current host grant is revoked", async () => {
    const authorizationError = Object.assign(
      new Error("Remote Docker host access has been revoked"),
      { code: "REMOTE_HOST_ACCESS_REVOKED" },
    );
    mockAssertRemoteHostAgentUse
      .mockResolvedValueOnce({ id: "shared-host" })
      .mockRejectedValueOnce(authorizationError);

    let captureSignal = null;
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation((_url, options = {}) => {
      captureSignal = options.signal;
      return new Promise((_resolve, reject) => {
        const rejectFromAbort = () => reject(captureSignal.reason);
        if (captureSignal.aborted) rejectFromAbort();
        else captureSignal.addEventListener("abort", rejectFromAbort, { once: true });
      });
    });

    try {
      await expect(
        buildTemplatePayloadFromAgent(
          {
            id: "remote-agent",
            user_id: "user-1",
            name: "Remote agent",
            runtime_family: "openclaw",
            deploy_target: "remote-docker",
            execution_target_id: "remote:shared-host",
            runtime_host: "10.0.0.12",
            runtime_port: 9090,
            template_payload: {
              files: [
                {
                  path: "STALE.md",
                  contentBase64: Buffer.from("must not be accepted").toString("base64"),
                },
              ],
            },
          },
          "files_only",
          { authorizationRecheckMs: 1 },
        ),
      ).rejects.toBe(authorizationError);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(captureSignal?.aborted).toBe(true);
      expect(captureSignal?.reason).toBe(authorizationError);
      expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(2);

      const settledCheckCount = mockAssertRemoteHostAgentUse.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(settledCheckCount);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("forwards a caller abort into a Remote Docker capture without leaking its watcher", async () => {
    const callerController = new AbortController();
    const callerError = new Error("request cancelled");
    let captureSignal = null;
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation((_url, options = {}) => {
      captureSignal = options.signal;
      return new Promise((_resolve, reject) => {
        const rejectFromAbort = () => reject(captureSignal.reason);
        if (captureSignal.aborted) rejectFromAbort();
        else captureSignal.addEventListener("abort", rejectFromAbort, { once: true });
      });
    });

    try {
      const capture = buildTemplatePayloadFromAgent(
        {
          id: "remote-agent",
          user_id: "user-1",
          name: "Remote agent",
          runtime_family: "openclaw",
          deploy_target: "remote-docker",
          execution_target_id: "remote:shared-host",
          runtime_host: "10.0.0.12",
          runtime_port: 9090,
        },
        "files_only",
        { signal: callerController.signal, authorizationRecheckMs: 60000 },
      );

      for (let attempt = 0; attempt < 20 && !captureSignal; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(captureSignal).toBeTruthy();
      callerController.abort(callerError);

      await expect(capture).rejects.toBe(callerError);
      expect(captureSignal).not.toBe(callerController.signal);
      expect(captureSignal.reason).toBe(callerError);
      expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(1);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockAssertRemoteHostAgentUse).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
