import { describe, expect, it } from "vitest";

import * as mcpServersConfig from "../lib/mcpServersConfig.ts";

const { buildMcpServersConfig } = mcpServersConfig;

describe("buildMcpServersConfig", () => {
  it("emits a stdio npx entry keyed by server name with env", () => {
    const config = buildMcpServersConfig([
      {
        name: "gitlab",
        npmPackage: "@modelcontextprotocol/server-gitlab",
        env: { GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-xxx" },
      },
    ]);
    expect(config).toEqual({
      gitlab: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-gitlab"],
        env: { GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-xxx" },
      },
    });
  });

  it("appends extra args and drops empty/nullish env values", () => {
    const config = buildMcpServersConfig([
      {
        name: "supabase",
        npmPackage: "@supabase/mcp-server-supabase",
        args: ["--read-only"],
        env: { SUPABASE_ACCESS_TOKEN: "sbp", EMPTY: "", MISSING: null },
      },
    ]);
    expect(config.supabase.args).toEqual(["-y", "@supabase/mcp-server-supabase", "--read-only"]);
    expect(config.supabase.env).toEqual({ SUPABASE_ACCESS_TOKEN: "sbp" });
  });

  it("omits the env key entirely when there are no usable values", () => {
    const config = buildMcpServersConfig([{ name: "x", npmPackage: "@x/y", env: { A: "" } }]);
    expect(config.x).toEqual({ command: "npx", args: ["-y", "@x/y"] });
    expect("env" in config.x).toBe(false);
  });

  it("skips malformed entries and tolerates non-array input", () => {
    expect(buildMcpServersConfig([{ name: "no-pkg" }, { npmPackage: "no-name" }, null])).toEqual(
      {},
    );
    expect(buildMcpServersConfig(undefined)).toEqual({});
  });
});
