import { describe, expect, it } from "vitest";
import "tsx/cjs";

const bootstrap = require("../lib/hermesRuntimeBootstrap.ts");
const {
  isValidHermesProfileName,
  resolveHermesProfileHome,
  buildHermesProfileGatewayStartSnippet,
  buildHermesProfileGatewayStopSnippet,
  buildAllProfilesGatewayLaunchSnippet,
} = bootstrap;

describe("hermes profile home", () => {
  it("accepts default and valid slugs", () => {
    expect(isValidHermesProfileName("default")).toBe(true);
    expect(isValidHermesProfileName("coder")).toBe(true);
    expect(isValidHermesProfileName("michael-cto")).toBe(true);
  });

  it("rejects invalid names", () => {
    expect(isValidHermesProfileName("")).toBe(false);
    expect(isValidHermesProfileName("Bad_Name")).toBe(false);
    expect(isValidHermesProfileName("-lead")).toBe(false);
    expect(isValidHermesProfileName("../escape")).toBe(false);
  });

  it("maps default to /opt/data and named to the profiles subdir", () => {
    expect(resolveHermesProfileHome("default")).toBe("/opt/data");
    expect(resolveHermesProfileHome("coder")).toBe("/opt/data/profiles/coder");
  });

  it("throws on invalid names", () => {
    expect(() => resolveHermesProfileHome("../escape")).toThrow(/Invalid Hermes profile name/);
  });
});

describe("hermes profile gateway snippets", () => {
  it("start snippet scopes HERMES_HOME, disables the API server, writes a pidfile", () => {
    const snippet = buildHermesProfileGatewayStartSnippet("/opt/data/profiles/coder");
    expect(snippet).toContain('HERMES_HOME="/opt/data/profiles/coder"');
    expect(snippet).toContain("API_SERVER_ENABLED=false");
    expect(snippet).toContain("gateway run");
    expect(snippet).toContain("/opt/data/profiles/coder/gateway.pid");
    expect(snippet).toContain("nohup");
  });

  it("stop snippet kills the pidfile process", () => {
    const snippet = buildHermesProfileGatewayStopSnippet("/opt/data/profiles/coder");
    expect(snippet).toContain("/opt/data/profiles/coder/gateway.pid");
    expect(snippet).toContain("kill");
  });

  it("launch-all loops the profiles dir", () => {
    const snippet = buildAllProfilesGatewayLaunchSnippet();
    expect(snippet).toContain("/opt/data/profiles/");
    expect(snippet).toContain("for ");
  });
});
