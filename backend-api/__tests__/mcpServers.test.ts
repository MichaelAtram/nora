// @ts-nocheck
const mcpServers = require("../mcpServers");

// A trimmed catalog covering supported + unsupported + not-yet-available cases.
const CATALOG = [
  {
    id: "gitlab",
    name: "GitLab",
    mcp: {
      available: true,
      transport: "stdio",
      npmPackage: "@modelcontextprotocol/server-gitlab",
      docsUrl: "https://example.com/gitlab",
    },
  },
  {
    id: "notion",
    name: "Notion",
    mcp: { available: true, transport: "stdio", npmPackage: "@notionhq/notion-mcp-server" },
  },
  {
    id: "stripe",
    name: "Stripe",
    mcp: { available: true, transport: "stdio", npmPackage: "@stripe/mcp" },
  },
  {
    id: "supabase",
    name: "Supabase",
    mcp: { available: true, transport: "stdio", npmPackage: "@supabase/mcp-server-supabase" },
  },
  // Supported provider id, but the catalog has not declared it available.
  { id: "github", name: "GitHub", mcp: { available: false } },
  // Available, but not in the supported set (deferred — file/connection creds).
  {
    id: "kubernetes",
    name: "Kubernetes",
    mcp: { available: true, transport: "stdio", npmPackage: "@kubernetes/mcp-server" },
  },
];

describe("loadMcpCatalog", () => {
  it("returns only supported providers that declare a usable stdio server", () => {
    const ids = mcpServers.loadMcpCatalog(CATALOG).map((e) => e.provider);
    expect(ids.sort()).toEqual(["gitlab", "notion", "stripe", "supabase"]);
  });
});

describe("normalizeEnabledIds", () => {
  it("keeps supported ids, dedupes, and accepts {provider} objects", () => {
    expect(
      mcpServers.normalizeEnabledIds([
        "gitlab",
        "gitlab",
        { provider: "stripe" },
        "nope",
        "kubernetes",
      ]),
    ).toEqual(["gitlab", "stripe"]);
    expect(mcpServers.normalizeEnabledIds("not-an-array")).toEqual([]);
  });
});

describe("resolveMcpEntries", () => {
  it("injects each provider's credential under its server's expected env var", () => {
    const entries = mcpServers.resolveMcpEntries({
      enabledIds: ["gitlab", "notion"],
      integrationsByProvider: {
        gitlab: { token: "glpat-1", config: { api_url: "https://gl.example.com/api/v4" } },
        notion: { token: "secret_n" },
      },
      catalog: CATALOG,
    });
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName.gitlab.npmPackage).toBe("@modelcontextprotocol/server-gitlab");
    expect(byName.gitlab.env).toEqual({
      GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-1",
      GITLAB_API_URL: "https://gl.example.com/api/v4",
    });
    expect(byName.notion.env).toEqual({ NOTION_TOKEN: "secret_n" });
  });

  it("skips an enabled provider whose integration is missing or has no token", () => {
    const entries = mcpServers.resolveMcpEntries({
      enabledIds: ["gitlab", "stripe"],
      integrationsByProvider: { gitlab: { token: "" }, stripe: undefined },
      catalog: CATALOG,
    });
    expect(entries).toEqual([]);
  });
});

describe("getAvailableMcpServers", () => {
  function fakeDb({ mcpRows = [], connectedProviders = [] } = {}) {
    return {
      query: jest.fn(async (sql) => {
        if (/SELECT mcp_servers FROM agents/.test(sql)) return { rows: [{ mcp_servers: mcpRows }] };
        if (/FROM integrations/.test(sql))
          return { rows: connectedProviders.map((p) => ({ provider: p })) };
        return { rows: [] };
      }),
    };
  }

  it("annotates each supported server with connected + enabled", async () => {
    const dbClient = fakeDb({ mcpRows: ["gitlab"], connectedProviders: ["gitlab", "stripe"] });
    const servers = await mcpServers.getAvailableMcpServers("a-1", { dbClient, catalog: CATALOG });
    const byProvider = Object.fromEntries(servers.map((s) => [s.provider, s]));
    expect(byProvider.gitlab).toMatchObject({ connected: true, enabled: true });
    expect(byProvider.stripe).toMatchObject({ connected: true, enabled: false });
    expect(byProvider.notion).toMatchObject({ connected: false, enabled: false });
  });
});

describe("setAgentMcpServerIds", () => {
  it("validates against the supported set and writes JSON", async () => {
    const calls = [];
    const dbClient = {
      query: jest.fn(async (sql, params) => (calls.push({ sql, params }), { rows: [] })),
    };
    const result = await mcpServers.setAgentMcpServerIds("a-1", ["gitlab", "bogus", "gitlab"], {
      dbClient,
    });
    expect(result).toEqual(["gitlab"]);
    expect(calls[0].params[0]).toBe(JSON.stringify(["gitlab"]));
    expect(calls[0].params[1]).toBe("a-1");
  });
});
