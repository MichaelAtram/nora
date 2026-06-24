// @ts-nocheck
/**
 * __tests__/embedAgentColumns.test.ts — guards the SSRF-relevant column contract
 * for the embed-proxy agent lookups. A previous regression dropped these fields
 * from lookupHermesEmbedAgent's SELECT, which silently mis-authorized
 * remote-docker / k8s targets (the row reached the allowlist without the fields
 * it scopes on). This pins the contract so that can't recur.
 */
const { HERMES_EMBED_AGENT_COLUMNS, GATEWAY_EMBED_AGENT_COLUMNS } = require("../embedAgentColumns");

describe("embed-proxy agent SELECT columns", () => {
  // These are exactly the fields allowedGatewayHostsForAgent /
  // resolveHermesDashboardAddress read off the agent row to authorize the proxy
  // target. The Hermes embed lookup MUST load all of them.
  const SSRF_REQUIRED = [
    "deploy_target", // routes docker vs k8s vs remote-docker policy
    "execution_target_id", // looks up the registered remote host
    "user_id", // owner-scopes the remote host (cross-tenant guard)
    "gateway_host", // k8s/remote exposure host
    "gateway_port",
    "runtime_host", // local Hermes dashboard host
    "runtime_port",
  ];

  it("Hermes embed lookup loads every field the SSRF allowlist authorizes against", () => {
    for (const col of SSRF_REQUIRED) {
      expect(HERMES_EMBED_AGENT_COLUMNS).toContain(col);
    }
    // status + runtime_family gate availability / dashboard detection.
    expect(HERMES_EMBED_AGENT_COLUMNS).toContain("status");
    expect(HERMES_EMBED_AGENT_COLUMNS).toContain("runtime_family");
    // dashboard_port carries the remote published dashboard host port; without it
    // resolveHermesDashboardAddress targets the in-container 9119 on the remote host.
    expect(HERMES_EMBED_AGENT_COLUMNS).toContain("dashboard_port");
  });

  it("gateway embed lookup loads the gateway endpoint fields", () => {
    for (const col of [
      "gateway_host",
      "gateway_port",
      "gateway_host_port",
      "gateway_token",
      "status",
    ]) {
      expect(GATEWAY_EMBED_AGENT_COLUMNS).toContain(col);
    }
  });

  it("gateway embed lookup also loads the SSRF-authorizing fields (both embed proxies are guarded)", () => {
    // proxyEmbeddedGateway + proxyGatewayAsset route through
    // resolveSafeGatewayHttpTarget, so the gateway embed lookup needs the same
    // owner-scoping / routing fields the Hermes path does.
    for (const col of ["deploy_target", "execution_target_id", "user_id", "runtime_host"]) {
      expect(GATEWAY_EMBED_AGENT_COLUMNS).toContain(col);
    }
  });

  it("exposes plain string column names (safe to interpolate into the SELECT)", () => {
    for (const col of [...HERMES_EMBED_AGENT_COLUMNS, ...GATEWAY_EMBED_AGENT_COLUMNS]) {
      expect(typeof col).toBe("string");
      // Identifier-only — never a value or expression, so the join() into SQL
      // can't carry injection.
      expect(col).toMatch(/^[a-z_]+$/);
    }
  });
});
