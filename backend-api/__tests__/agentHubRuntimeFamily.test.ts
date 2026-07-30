// @ts-nocheck
const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);

const agentHubStore = require("../agentHubStore");

function existingListingRow(overrides = {}) {
  return {
    id: "listing-1",
    snapshot_id: "snapshot-1",
    owner_user_id: "user-1",
    name: "Existing Listing",
    description: "Existing description",
    price: "Free",
    category: "General",
    built_in: false,
    source_type: "community",
    runtime_family: "openclaw",
    status: "published",
    visibility: "public",
    share_target: "internal",
    local_visibility: "internal",
    central_share_status: "not_shared",
    central_listing_id: null,
    central_last_synced_at: null,
    central_error: null,
    slug: "existing-listing",
    current_version: 1,
    review_notes: null,
    ...overrides,
  };
}

function primeQueries({ existing = null, returnedRow = {} } = {}) {
  mockDb.query.mockImplementation(async (sql) => {
    const text = String(sql);
    if (text.includes("WHERE snapshot_id = $1 ORDER BY created_at")) {
      return { rows: existing ? [existing] : [] };
    }
    if (text.includes("WHERE slug = $1")) {
      return { rows: [] };
    }
    if (text.includes("SELECT * FROM agent_hub_listings WHERE id = $1")) {
      return { rows: existing ? [existing] : [] };
    }
    if (text.includes("agent_hub_listing_versions")) {
      return { rows: [] };
    }
    if (text.includes("INSERT INTO agent_hub_listings")) {
      return { rows: [returnedRow] };
    }
    if (text.includes("UPDATE agent_hub_listings")) {
      return { rows: [returnedRow] };
    }
    return { rows: [] };
  });
}

function findQueryCall(pattern) {
  return mockDb.query.mock.calls.find(([sql]) => String(sql).includes(pattern));
}

function insertParamIndexFor(sql, column) {
  const columnsMatch = String(sql).match(/INSERT INTO agent_hub_listings\(([\s\S]*?)\)\s*VALUES/i);
  expect(columnsMatch).not.toBeNull();
  const columns = columnsMatch[1].split(",").map((entry) => entry.trim());
  const index = columns.indexOf(column);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function updateParamIndexFor(sql, column) {
  const match = String(sql).match(new RegExp(`${column}\\s*=\\s*\\$(\\d+)`));
  expect(match).not.toBeNull();
  return Number(match[1]) - 1;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("agentHubStore runtime family persistence", () => {
  it("round-trips a known runtimeFamily through insert and returns the stored row", async () => {
    const stored = existingListingRow({ runtime_family: "hermes" });
    primeQueries({ returnedRow: stored });

    const listing = await agentHubStore.upsertListing({
      snapshotId: "snapshot-1",
      name: "Hermes Listing",
      runtimeFamily: "hermes",
    });

    const insertCall = findQueryCall("INSERT INTO agent_hub_listings");
    expect(insertCall).toBeDefined();
    const [insertSql, insertParams] = insertCall;
    expect(insertParams[insertParamIndexFor(insertSql, "runtime_family")]).toBe("hermes");
    expect(listing.runtime_family).toBe("hermes");
  });

  it("defaults runtime_family to openclaw when runtimeFamily is absent", async () => {
    primeQueries({ returnedRow: existingListingRow() });

    await agentHubStore.upsertListing({
      snapshotId: "snapshot-1",
      name: "Plain Listing",
    });

    const [insertSql, insertParams] = findQueryCall("INSERT INTO agent_hub_listings");
    expect(insertParams[insertParamIndexFor(insertSql, "runtime_family")]).toBe("openclaw");
  });

  it("normalizes runtimeFamily case and whitespace", async () => {
    primeQueries({ returnedRow: existingListingRow({ runtime_family: "hermes" }) });

    await agentHubStore.upsertListing({
      snapshotId: "snapshot-1",
      name: "Hermes Listing",
      runtimeFamily: "  HeRmEs  ",
    });

    const [insertSql, insertParams] = findQueryCall("INSERT INTO agent_hub_listings");
    expect(insertParams[insertParamIndexFor(insertSql, "runtime_family")]).toBe("hermes");
  });

  it("collapses unknown runtime families to openclaw instead of persisting free text", async () => {
    primeQueries({ returnedRow: existingListingRow() });

    await agentHubStore.upsertListing({
      snapshotId: "snapshot-1",
      name: "Odd Listing",
      runtimeFamily: "quantum-claw",
    });

    const [insertSql, insertParams] = findQueryCall("INSERT INTO agent_hub_listings");
    expect(insertParams[insertParamIndexFor(insertSql, "runtime_family")]).toBe("openclaw");
  });

  it("preserves the existing listing family on update when runtimeFamily is not provided", async () => {
    const existing = existingListingRow({ runtime_family: "hermes" });
    primeQueries({ existing, returnedRow: existing });

    await agentHubStore.upsertListing({
      listingId: existing.id,
      snapshotId: existing.snapshot_id,
      name: "Renamed Listing",
    });

    const updateCall = findQueryCall("UPDATE agent_hub_listings");
    expect(updateCall).toBeDefined();
    const [updateSql, updateParams] = updateCall;
    expect(updateParams[updateParamIndexFor(updateSql, "runtime_family")]).toBe("hermes");
  });

  it("persists an explicit runtimeFamily change on update", async () => {
    const existing = existingListingRow({ runtime_family: "openclaw" });
    primeQueries({ existing, returnedRow: existing });

    await agentHubStore.upsertListing({
      listingId: existing.id,
      snapshotId: existing.snapshot_id,
      name: "Now Hermes",
      runtimeFamily: "hermes",
    });

    const [updateSql, updateParams] = findQueryCall("UPDATE agent_hub_listings");
    expect(updateParams[updateParamIndexFor(updateSql, "runtime_family")]).toBe("hermes");
  });
});

describe("agentHubStore listing queries include runtime_family", () => {
  it.each([
    ["getListing", () => agentHubStore.getListing("listing-1")],
    ["listAgentHubLocalListings", () => agentHubStore.listAgentHubLocalListings()],
    ["listUserListings", () => agentHubStore.listUserListings("user-1")],
    ["listCommunityCatalog", () => agentHubStore.listCommunityCatalog()],
    ["listAdminListings", () => agentHubStore.listAdminListings()],
    ["getPlatformListingByTemplateKey", () => agentHubStore.getPlatformListingByTemplateKey("key")],
  ])("selects ml.runtime_family in %s", async (_name, run) => {
    mockDb.query.mockResolvedValue({ rows: [] });

    await run();

    const listingSelect = mockDb.query.mock.calls.find(([sql]) =>
      String(sql).includes("FROM agent_hub_listings ml"),
    );
    expect(listingSelect).toBeDefined();
    expect(String(listingSelect[0])).toContain("ml.runtime_family");
  });
});
