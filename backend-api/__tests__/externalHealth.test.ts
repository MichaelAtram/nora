// @ts-nocheck
const mockResolveGateway = jest.fn();
const mockResolveHermes = jest.fn();
jest.mock("../gatewayProxy", () => ({
  resolveSafeGatewayHttpTarget: (...a) => mockResolveGateway(...a),
  resolveSafeHermesDashboardTarget: (...a) => mockResolveHermes(...a),
}));

const { probeExternalAgentHealth } = require("../externalHealth");

beforeEach(() => {
  mockResolveGateway.mockReset();
  mockResolveHermes.mockReset();
});

describe("probeExternalAgentHealth", () => {
  it("resolves an OpenClaw agent through the gateway allowlist and reports running on any response", async () => {
    mockResolveGateway.mockResolvedValue({
      url: "http://203.0.113.5:18789/",
      hostHeader: "203.0.113.5:18789",
    });
    const fetchImpl = jest.fn().mockResolvedValue({ status: 426 });

    const result = await probeExternalAgentHealth(
      { runtime_family: "openclaw", deploy_target: "external", gateway_host: "203.0.113.5" },
      { fetchImpl },
    );

    expect(result).toEqual({ running: true });
    expect(mockResolveGateway).toHaveBeenCalled();
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://203.0.113.5:18789/");
    expect(opts.headers.Host).toBe("203.0.113.5:18789");
    expect(opts.redirect).toBe("manual"); // never follow a redirect off the allowlist
  });

  it("resolves a Hermes agent through the dashboard allowlist", async () => {
    mockResolveHermes.mockResolvedValue({ host: "203.0.113.6", port: 9119 });
    const fetchImpl = jest.fn().mockResolvedValue({ status: 200 });

    const result = await probeExternalAgentHealth(
      { runtime_family: "hermes", deploy_target: "external", gateway_host: "203.0.113.6" },
      { fetchImpl },
    );

    expect(result).toEqual({ running: true });
    expect(mockResolveHermes).toHaveBeenCalled();
    expect(fetchImpl.mock.calls[0][0]).toBe("http://203.0.113.6:9119/");
  });

  it("reports not running when the fetch fails (connection refused / timeout)", async () => {
    mockResolveGateway.mockResolvedValue({ url: "http://203.0.113.5:18789/", hostHeader: "x" });
    const fetchImpl = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await probeExternalAgentHealth(
      { runtime_family: "openclaw", deploy_target: "external" },
      { fetchImpl },
    );

    expect(result).toEqual({ running: false });
  });

  it("reports not running when the endpoint can't be resolved/allowlisted", async () => {
    mockResolveGateway.mockRejectedValue(new Error("not an allowed gateway address"));
    const fetchImpl = jest.fn();

    const result = await probeExternalAgentHealth(
      { runtime_family: "openclaw", deploy_target: "external" },
      { fetchImpl },
    );

    expect(result).toEqual({ running: false });
    expect(fetchImpl).not.toHaveBeenCalled(); // never fetch an unresolved/disallowed target
  });
});
