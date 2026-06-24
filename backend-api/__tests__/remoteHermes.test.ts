// @ts-nocheck
const RemoteHermesBackend = require("../../workers/provisioner/backends/remote-hermes");
const HermesBackend = require("../../workers/provisioner/backends/hermes");
const { HERMES_RUNTIME_PORT, HERMES_DASHBOARD_PORT } = require("../../agent-runtime/lib/contracts");

function hermesProfile(overrides = {}) {
  return {
    id: "my-laptop",
    executionTargetId: "remote:my-laptop",
    label: "My Laptop",
    sshHost: "100.64.0.5",
    sshPort: 2222,
    sshUser: "operator",
    sshAuthMode: "key",
    sshPrivateKey: "PRIVATE-KEY-PEM",
    gatewayHost: "laptop.tail-scale.ts.net",
    ...overrides,
  };
}

describe("RemoteHermesBackend construction", () => {
  it("rejects a profile without a remote: execution target", () => {
    expect(() => new RemoteHermesBackend(hermesProfile({ executionTargetId: "docker" }))).toThrow(
      /registered remote host profile/i,
    );
  });

  it("rejects a profile missing SSH connection details or credential", () => {
    expect(() => new RemoteHermesBackend(hermesProfile({ sshHost: "" }))).toThrow(
      /missing SSH connection details/i,
    );
    expect(() => new RemoteHermesBackend(hermesProfile({ sshPrivateKey: null }))).toThrow(
      /missing its SSH private key/i,
    );
  });

  it("points the dockerode client at the remote daemon over SSH", () => {
    const backend = new RemoteHermesBackend(hermesProfile());
    expect(backend.docker.modem.protocol).toBe("ssh");
    expect(backend.docker.modem.host).toBe("100.64.0.5");
  });

  it("never discovers a compose network", async () => {
    const backend = new RemoteHermesBackend(hermesProfile());
    expect(backend._composeNetwork).toBeNull();
    await expect(backend._findComposeNetwork()).resolves.toBeNull();
  });
});

describe("RemoteHermesBackend port publishing", () => {
  it("publishes BOTH the runtime port (readiness) and the dashboard port (UI) on their host ports", () => {
    const backend = new RemoteHermesBackend(hermesProfile());
    const bindings = backend._hermesPortBindings({
      gatewayHostPort: 19500,
      dashboardHostPort: 19044,
    });
    expect(bindings).toEqual({
      [`${HERMES_RUNTIME_PORT}/tcp`]: [{ HostPort: "19500" }],
      [`${HERMES_DASHBOARD_PORT}/tcp`]: [{ HostPort: "19044" }],
    });
  });

  it("publishes only the runtime port when no dashboard port is allocated", () => {
    const backend = new RemoteHermesBackend(hermesProfile());
    expect(backend._hermesPortBindings({ gatewayHostPort: 19500 })).toEqual({
      [`${HERMES_RUNTIME_PORT}/tcp`]: [{ HostPort: "19500" }],
    });
  });

  it("publishes only the dashboard port when no runtime port is allocated", () => {
    const backend = new RemoteHermesBackend(hermesProfile());
    expect(backend._hermesPortBindings({ dashboardHostPort: 19044 })).toEqual({
      [`${HERMES_DASHBOARD_PORT}/tcp`]: [{ HostPort: "19044" }],
    });
  });

  it("publishes nothing when no host port is allocated", () => {
    const backend = new RemoteHermesBackend(hermesProfile());
    expect(backend._hermesPortBindings({})).toBeUndefined();
    expect(backend._hermesPortBindings({ gatewayHostPort: 0 })).toBeUndefined();
  });

  it("leaves local Hermes unpublished (base hook returns undefined)", () => {
    // The base HermesBackend must not publish any host ports — local Hermes is
    // reached via the container IP on the shared compose network.
    expect(HermesBackend.prototype._hermesPortBindings()).toBeUndefined();
  });
});

describe("RemoteHermesBackend.create", () => {
  afterEach(() => jest.restoreAllMocks());

  it("advertises the remote host address + published runtime and dashboard ports", async () => {
    jest.spyOn(HermesBackend.prototype, "create").mockResolvedValue({
      containerId: "nora-hermes-x",
      containerName: "nora-hermes-x",
      gatewayToken: "tok",
      host: "172.18.0.9",
      runtimeHost: "172.18.0.9",
      runtimePort: 8642,
    });
    const backend = new RemoteHermesBackend(hermesProfile());

    const result = await backend.create({
      id: "x",
      name: "Hermes QA",
      gatewayHostPort: 19500,
      dashboardHostPort: 19044,
    });

    expect(result.host).toBe("laptop.tail-scale.ts.net");
    expect(result.runtimeHost).toBe("laptop.tail-scale.ts.net");
    // runtime_port is the published host port so readiness reaches /health
    expect(result.runtimePort).toBe(19500);
    // dashboard_port is the published host port so the embed proxy resolves the UI
    expect(result.dashboardPort).toBe(19044);
    expect(result.containerId).toBe("nora-hermes-x");
  });

  it("reports a null dashboard port when none was allocated", async () => {
    jest.spyOn(HermesBackend.prototype, "create").mockResolvedValue({
      containerId: "c",
      containerName: "c",
      host: "172.18.0.9",
      runtimeHost: "172.18.0.9",
      runtimePort: 8642,
    });
    const backend = new RemoteHermesBackend(hermesProfile());
    const result = await backend.create({ id: "x", gatewayHostPort: 19500 });
    expect(result.dashboardPort).toBeNull();
  });

  it("falls back to the SSH host when no advertised gateway host is set", async () => {
    jest.spyOn(HermesBackend.prototype, "create").mockResolvedValue({
      containerId: "c",
      containerName: "c",
      host: "172.18.0.9",
      runtimeHost: "172.18.0.9",
      runtimePort: 8642,
    });
    const backend = new RemoteHermesBackend(hermesProfile({ gatewayHost: "" }));
    const result = await backend.create({ id: "x", gatewayHostPort: 19500 });
    expect(result.runtimeHost).toBe("100.64.0.5");
  });
});
