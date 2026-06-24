// @ts-nocheck
/**
 * __tests__/remoteHostGatewayAllowlist.test.ts — A3a: the HTTP gateway proxy
 * allows a remote-docker agent's own registered host address (which is not
 * RFC1918), while never widening the allowlist for other agents and still
 * enforcing the hard blocked-IP floor.
 */
jest.mock("../db", () => ({ query: jest.fn() }));
jest.mock("../integrations", () => ({}));
jest.mock("../metrics", () => ({ recordMetric: jest.fn(), recordTokenUsage: jest.fn() }));
jest.mock("../agentBudgets", () => ({ checkAndEnforce: jest.fn() }));
jest.mock("ws", () => ({ WebSocket: class {}, WebSocketServer: class {} }));

const mockGetRemoteHostByExecutionTarget = jest.fn();
const mockUserCanUseRemoteHost = jest.fn().mockResolvedValue(false);
jest.mock("../remoteHosts", () => ({
  getRemoteHostByExecutionTarget: (...args) => mockGetRemoteHostByExecutionTarget(...args),
  userCanUseRemoteHost: (...args) => mockUserCanUseRemoteHost(...args),
}));

const {
  resolveSafeGatewayHttpTarget,
  resolveSafeHermesDashboardTarget,
  assertExternalEndpointReachable,
} = require("../gatewayProxy");

const PUBLIC_IP = "203.0.113.5";

function remoteAgent(overrides = {}) {
  return {
    id: "agent-1",
    user_id: "user-1",
    deploy_target: "remote-docker",
    execution_target_id: "remote:my-vps",
    gateway_host: PUBLIC_IP,
    gateway_port: 19042,
    ...overrides,
  };
}

beforeEach(() => {
  mockGetRemoteHostByExecutionTarget.mockReset();
  mockUserCanUseRemoteHost.mockReset();
  mockUserCanUseRemoteHost.mockResolvedValue(false);
});

describe("remote-host gateway allowlist (HTTP proxy)", () => {
  it("allows a remote-docker agent's own registered (non-RFC1918) host", async () => {
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-1",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
    const target = await resolveSafeGatewayHttpTarget(remoteAgent(), "status");
    expect(target.url).toBe(`http://${PUBLIC_IP}:19042/status`);
    expect(mockGetRemoteHostByExecutionTarget).toHaveBeenCalledWith("remote:my-vps");
  });

  it("does NOT trust a remote host registered by a different operator", async () => {
    // Cross-tenant execution_target_id reference: the host belongs to user-2 and is
    // NOT shared to user-1 (userCanUseRemoteHost defaults to false).
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-2",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
    await expect(resolveSafeGatewayHttpTarget(remoteAgent(), "status")).rejects.toThrow(
      /not an allowed gateway address/i,
    );
    expect(mockUserCanUseRemoteHost).toHaveBeenCalledWith("user-1", "my-vps");
  });

  it("trusts another operator's host when it is SHARED to the agent owner (C3 grant)", async () => {
    // host owned by user-2 but shared into a workspace where user-1 is editor+.
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-2",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
    mockUserCanUseRemoteHost.mockResolvedValue(true);
    const target = await resolveSafeGatewayHttpTarget(remoteAgent(), "status");
    expect(target.url).toBe(`http://${PUBLIC_IP}:19042/status`);
    expect(mockUserCanUseRemoteHost).toHaveBeenCalledWith("user-1", "my-vps");
  });

  it("rejects a public host when no matching remote host is registered", async () => {
    mockGetRemoteHostByExecutionTarget.mockResolvedValue(null);
    await expect(resolveSafeGatewayHttpTarget(remoteAgent(), "status")).rejects.toThrow(
      /not an allowed gateway address/i,
    );
  });

  it("fails closed on a null-owner host — runs the grant check, does not short-circuit", async () => {
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: null,
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
    // userCanUseRemoteHost defaults to false → no grant → blocked.
    await expect(resolveSafeGatewayHttpTarget(remoteAgent(), "status")).rejects.toThrow(
      /not an allowed gateway address/i,
    );
    expect(mockUserCanUseRemoteHost).toHaveBeenCalledWith("user-1", "my-vps");
  });

  it("does NOT widen the allowlist for a non-remote agent with a public host", async () => {
    // A docker agent must never reach a public address — the registry lookup is
    // skipped entirely (deploy_target !== remote-docker).
    const dockerAgent = remoteAgent({ deploy_target: "docker", execution_target_id: "docker" });
    await expect(resolveSafeGatewayHttpTarget(dockerAgent, "status")).rejects.toThrow(
      /not an allowed gateway address/i,
    );
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });

  it("still blocks dangerous addresses even for a registered remote host", async () => {
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      gatewayHost: "169.254.169.254",
      sshHost: "169.254.169.254",
    });
    const linkLocal = remoteAgent({ gateway_host: "169.254.169.254" });
    await expect(resolveSafeGatewayHttpTarget(linkLocal, "status")).rejects.toThrow(
      /not an allowed gateway address/i,
    );
  });

  it("trusts a k8s agent's operator-provisioned (public LoadBalancer) address", async () => {
    // k8s exposure addresses (LB/NodePort) are operator-provisioned, so RPC/WS/HTTP
    // must reach them even when public — without a registry lookup.
    const k8sAgent = {
      id: "agent-k8s",
      user_id: "user-1",
      deploy_target: "k8s",
      execution_target_id: "k8s:prod",
      gateway_host: "203.0.113.20",
      gateway_port: 18789,
    };
    const target = await resolveSafeGatewayHttpTarget(k8sAgent, "status");
    expect(target.url).toBe("http://203.0.113.20:18789/status");
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });

  it("allows a docker agent to reach a custom (non-RFC1918) GATEWAY_HOST published host", async () => {
    // Regression guard: a docker agent reaches its gateway via the operator's
    // GATEWAY_HOST (publishedHost), which may not be RFC1918. Trusting it keeps
    // docker chat working regardless of what the operator configured.
    const prev = process.env.GATEWAY_HOST;
    process.env.GATEWAY_HOST = "198.51.100.7"; // public test IP, not RFC1918
    try {
      const dockerAgent = {
        id: "agent-docker",
        user_id: "user-1",
        deploy_target: "docker",
        execution_target_id: "docker",
        gateway_host: null,
        gateway_host_port: 19042,
      };
      const target = await resolveSafeGatewayHttpTarget(dockerAgent, "status");
      expect(target.url).toBe("http://198.51.100.7:19042/status");
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_HOST;
      else process.env.GATEWAY_HOST = prev;
    }
  });

  it("still allows an ordinary RFC1918 docker host (no regression)", async () => {
    const dockerAgent = remoteAgent({
      deploy_target: "docker",
      execution_target_id: "docker",
      gateway_host: "10.0.0.10",
      gateway_port: 19000,
    });
    const target = await resolveSafeGatewayHttpTarget(dockerAgent, "status");
    expect(target.url).toBe("http://10.0.0.10:19000/status");
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });
});

describe("hermes dashboard embed-proxy allowlist (SSRF)", () => {
  it("allows a local Hermes agent's RFC1918 dashboard host", async () => {
    const agent = {
      id: "hermes-1",
      user_id: "user-1",
      runtime_family: "hermes",
      deploy_target: "docker",
      execution_target_id: "docker",
      runtime_host: "10.0.0.7",
    };
    const target = await resolveSafeHermesDashboardTarget(agent);
    expect(target).toEqual({ host: "10.0.0.7", port: 9119 });
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });

  it("rejects a Hermes agent whose runtime_host is a public address (SSRF guard)", async () => {
    const agent = {
      id: "hermes-2",
      user_id: "user-1",
      runtime_family: "hermes",
      deploy_target: "docker",
      execution_target_id: "docker",
      runtime_host: PUBLIC_IP,
    };
    await expect(resolveSafeHermesDashboardTarget(agent)).rejects.toThrow(
      /not an allowed gateway address/i,
    );
  });

  it("allows a remote Hermes agent's own registered host (owner-scoped)", async () => {
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-1",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
    const agent = {
      id: "hermes-3",
      user_id: "user-1",
      runtime_family: "hermes",
      deploy_target: "remote-docker",
      execution_target_id: "remote:my-vps",
      runtime_host: PUBLIC_IP,
      // B2c-2: the remote dashboard is published on its own host port (in the
      // gateway range) and persisted in dashboard_port. The embed proxy resolves
      // {runtime_host, dashboard_port} and the owner-scoped registered host is
      // trusted by the allowlist.
      dashboard_port: 19044,
    };
    const target = await resolveSafeHermesDashboardTarget(agent);
    expect(target).toEqual({ host: PUBLIC_IP, port: 19044 });
  });

  it("does not trust a remote Hermes host registered by another operator", async () => {
    mockGetRemoteHostByExecutionTarget.mockResolvedValue({
      id: "my-vps",
      ownerUserId: "user-2",
      gatewayHost: PUBLIC_IP,
      sshHost: PUBLIC_IP,
    });
    const agent = {
      id: "hermes-4",
      user_id: "user-1",
      runtime_family: "hermes",
      deploy_target: "remote-docker",
      execution_target_id: "remote:my-vps",
      runtime_host: PUBLIC_IP,
      runtime_port: 19042,
    };
    await expect(resolveSafeHermesDashboardTarget(agent)).rejects.toThrow(
      /not an allowed gateway address/i,
    );
  });

  it("trusts a k8s Hermes agent's provisioned (public LoadBalancer/NodePort) dashboard", async () => {
    // k8s exposure addresses are operator-provisioned, so the dashboard must be
    // reachable even on a public IP — without a remote-host registry lookup. This
    // relies on gateway_host/gateway_port being loaded by the embed lookup.
    const agent = {
      id: "hermes-k8s",
      user_id: "user-1",
      runtime_family: "hermes",
      deploy_target: "k8s",
      execution_target_id: "k8s:prod",
      gateway_host: "203.0.113.20",
      gateway_port: 30119, // NodePort range
      runtime_host: "10.42.0.3",
    };
    const target = await resolveSafeHermesDashboardTarget(agent);
    expect(target).toEqual({ host: "203.0.113.20", port: 30119 });
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });
});

describe("external runtime adoption (BYOC Phase C)", () => {
  describe("assertExternalEndpointReachable (registration gate)", () => {
    it("allows a public endpoint on the gateway port (selfhosted)", async () => {
      await expect(
        assertExternalEndpointReachable({ host: PUBLIC_IP, port: 18789 }, { paas: false }),
      ).resolves.toEqual({ host: PUBLIC_IP, port: 18789 });
    });

    it("allows a private endpoint in selfhosted mode (operator's own network)", async () => {
      await expect(
        assertExternalEndpointReachable({ host: "10.0.0.7", port: 18789 }, { paas: false }),
      ).resolves.toEqual({ host: "10.0.0.7", port: 18789 });
    });

    it("rejects a private endpoint in hosted (PaaS) mode (no internal pivot)", async () => {
      await expect(
        assertExternalEndpointReachable({ host: "10.0.0.7", port: 18789 }, { paas: true }),
      ).rejects.toThrow(/public address in hosted mode/i);
    });

    it("rejects a blocked (metadata/link-local) endpoint regardless of mode (floor)", async () => {
      await expect(
        assertExternalEndpointReachable({ host: "169.254.169.254", port: 18789 }, { paas: false }),
      ).rejects.toThrow(/not an allowed gateway address/i);
    });

    it("rejects a non-allowed port", async () => {
      await expect(
        assertExternalEndpointReachable({ host: PUBLIC_IP, port: 80 }, { paas: false }),
      ).rejects.toThrow(/port is not allowed/i);
    });

    it("allows the Hermes dashboard port (9119)", async () => {
      await expect(
        assertExternalEndpointReachable({ host: PUBLIC_IP, port: 9119 }, { paas: false }),
      ).resolves.toEqual({ host: PUBLIC_IP, port: 9119 });
    });
  });

  it("the proxy trusts an adopted external agent's own declared endpoint", async () => {
    // deploy_target='external' ⇒ allowedGatewayHostsForAgent trusts the agent's own
    // gateway_host (owner-scoped via the row); the public endpoint is reachable.
    const agent = {
      id: "agent-ext",
      user_id: "user-1",
      deploy_target: "external",
      execution_target_id: "external",
      gateway_host: PUBLIC_IP,
      gateway_port: 18789,
    };
    const target = await resolveSafeGatewayHttpTarget(agent, "status");
    expect(target.url).toBe(`http://${PUBLIC_IP}:18789/status`);
    expect(mockGetRemoteHostByExecutionTarget).not.toHaveBeenCalled();
  });
});
