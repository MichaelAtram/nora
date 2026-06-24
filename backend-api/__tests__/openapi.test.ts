// @ts-nocheck
// OpenAPI anti-rot: the spec must cover every route the tier-1 routers
// actually serve, and must not document routes that no longer exist. Requiring
// the routers pulls in db/queue modules — reuse the same mocks the route tests
// use so introspection works without infrastructure.

process.env.JWT_SECRET = process.env.JWT_SECRET || "x".repeat(40);

jest.mock("../db", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../redisQueue", () => ({
  deployQueue: { getJobCounts: jest.fn() },
  addDeploymentJob: jest.fn(),
  getDLQJobs: jest.fn(),
  retryDLQJob: jest.fn(),
}));
jest.mock("../scheduler", () => ({ selectNode: jest.fn() }));
jest.mock("../containerManager", () => ({
  start: jest.fn(),
  stop: jest.fn(),
  restart: jest.fn(),
  destroy: jest.fn(),
  canDestroy: jest.fn(),
  isKubernetesAgent: jest.fn(),
  status: jest.fn(),
}));
jest.mock("../authSync", () => ({
  runContainerCommand: jest.fn(),
  syncAuthToUserAgents: jest.fn(),
}));
jest.mock("../gatewayProxy", () => ({ rpcCall: jest.fn() }));

const { listRouterPaths } = require("../openapi/routerPaths");
const { buildOpenApiDocument } = require("../openapi");

// Tier-1 routers and their mount prefixes (must match server.ts).
const TIER1 = [
  { name: "agents", router: () => require("../routes/agents"), mount: "/agents" },
  { name: "monitoring", router: () => require("../routes/monitoring"), mount: "" },
  {
    name: "llmProviders",
    router: () => require("../routes/llmProviders"),
    mount: "/llm-providers",
  },
  { name: "auth", router: () => require("../routes/auth"), mount: "/auth" },
];

function specOperationKeys(doc) {
  const keys = new Set();
  for (const [path, ops] of Object.entries(doc.paths || {})) {
    for (const method of Object.keys(ops || {})) {
      keys.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return keys;
}

describe("OpenAPI document", () => {
  const doc = buildOpenApiDocument();

  it("is a structurally sane 3.1 document", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toMatch(/Nora/);
    expect(doc.servers[0].url).toBe("/api");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(20);
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });

  it("gives every operation a tag and a summary", () => {
    const knownTags = new Set(doc.tags.map((t) => t.name));
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(`${method.toUpperCase()} ${path}: ${op.summary || "MISSING SUMMARY"}`).not.toMatch(
          /MISSING SUMMARY/,
        );
        expect(Array.isArray(op.tags) && op.tags.length > 0).toBe(true);
        for (const tag of op.tags) {
          expect(knownTags.has(tag) ? tag : `unknown tag "${tag}" on ${path}`).toBe(tag);
        }
      }
    }
  });

  describe("drift against tier-1 routers", () => {
    const specKeys = specOperationKeys(doc);

    for (const tier of TIER1) {
      it(`covers every route in routes/${tier.name}`, () => {
        const served = listRouterPaths(tier.router(), tier.mount);
        const missing = served.filter((key) => !specKeys.has(key));
        expect(missing).toEqual([]);
      });
    }

    it("documents no stale routes for tier-1 prefixes", () => {
      const served = new Set(TIER1.flatMap((t) => listRouterPaths(t.router(), t.mount)));
      const tierPrefixes = ["/agents", "/monitoring", "/llm-providers", "/auth"];
      const stale = [...specKeys].filter((key) => {
        const path = key.split(" ")[1];
        return tierPrefixes.some((p) => path.startsWith(p)) && !served.has(key);
      });
      expect(stale).toEqual([]);
    });
  });
});
