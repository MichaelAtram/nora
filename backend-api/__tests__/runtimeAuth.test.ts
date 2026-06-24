// @ts-nocheck
const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);

const { runtimeAuthHeaders } = require("../runtimeAuth");
const { buildRuntimeAuthHeaders } = require("../../agent-runtime/lib/agentEndpoints");

beforeEach(() => mockDb.query.mockReset());

describe("buildRuntimeAuthHeaders", () => {
  it("formats a Bearer header, or nothing when tokenless", () => {
    expect(buildRuntimeAuthHeaders("tok-123")).toEqual({ Authorization: "Bearer tok-123" });
    expect(buildRuntimeAuthHeaders("")).toEqual({});
    expect(buildRuntimeAuthHeaders(null)).toEqual({});
  });
});

describe("runtimeAuthHeaders", () => {
  it("uses the token already on the agent without touching the DB", async () => {
    const headers = await runtimeAuthHeaders({ id: "a1", gateway_token: "from-row" });
    expect(headers).toEqual({ Authorization: "Bearer from-row" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("falls back to a DB lookup when the agent object omits the token", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ gateway_token: "from-db" }] });
    const headers = await runtimeAuthHeaders({ id: "a1" });
    expect(headers).toEqual({ Authorization: "Bearer from-db" });
    expect(mockDb.query.mock.calls[0][1]).toEqual(["a1"]);
  });

  it("returns no header when neither the row nor the DB has a token", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    expect(await runtimeAuthHeaders({ id: "a1" })).toEqual({});
  });

  it("degrades to no header (never throws) when the DB lookup fails", async () => {
    mockDb.query.mockRejectedValueOnce(new Error("db down"));
    expect(await runtimeAuthHeaders({ id: "a1" })).toEqual({});
  });

  it("returns no header for a null/idless agent", async () => {
    expect(await runtimeAuthHeaders(null)).toEqual({});
    expect(await runtimeAuthHeaders({})).toEqual({});
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
