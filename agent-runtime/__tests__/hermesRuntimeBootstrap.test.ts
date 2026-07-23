import { describe, expect, it } from "vitest";
import "tsx/cjs";

const bootstrap = require("../lib/hermesRuntimeBootstrap.ts");
const { isValidHermesProfileName, resolveHermesProfileHome } = bootstrap;

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
