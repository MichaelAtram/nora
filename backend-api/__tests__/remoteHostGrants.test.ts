// @ts-nocheck
// BYOC C3: workspace-shared remote hosts. Verifies userCanUseRemoteHost (the
// positive grant check that widens the owner-only deploy/reach gates) and the
// share/unshare helpers.
const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);
jest.mock("../crypto", () => ({
  encrypt: (v) => v,
  decrypt: (v) => v,
  ensureEncryptionConfigured: jest.fn(),
}));

const { userCanUseRemoteHost, shareRemoteHost, unshareRemoteHost } = require("../remoteHosts");

beforeEach(() => mockDb.query.mockReset());

// Route db.query on SQL shape: the ownership probe vs the workspace-grant probe.
function fakeAccess({ owned = false, sharedEditorPlus = false, grantsTableMissing = false } = {}) {
  mockDb.query.mockImplementation(async (sql) => {
    if (/FROM remote_hosts WHERE id = \$1 AND owner_user_id/.test(sql)) {
      return { rows: owned ? [{ "?column?": 1 }] : [] };
    }
    if (/FROM workspace_remote_hosts/.test(sql)) {
      if (grantsTableMissing) {
        const err = new Error('relation "workspace_remote_hosts" does not exist');
        err.code = "42P01";
        throw err;
      }
      return { rows: sharedEditorPlus ? [{ "?column?": 1 }] : [] };
    }
    return { rows: [] };
  });
}

describe("userCanUseRemoteHost", () => {
  it("allows the host owner", async () => {
    fakeAccess({ owned: true });
    expect(await userCanUseRemoteHost("user-1", "host-1")).toBe(true);
    // owner short-circuits before the workspace-grant query
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("allows an editor+ member of a workspace the host is shared into", async () => {
    fakeAccess({ owned: false, sharedEditorPlus: true });
    expect(await userCanUseRemoteHost("user-2", "host-1")).toBe(true);
    // The grant query filters role = ANY(editor/admin/owner).
    const grantCall = mockDb.query.mock.calls.find((c) => /workspace_remote_hosts/.test(c[0]));
    expect(grantCall[0]).toMatch(/wm\.role = ANY/);
    expect(grantCall[1]).toEqual(["host-1", "user-2", ["editor", "admin", "owner"]]);
  });

  it("denies a user with no ownership and no qualifying grant (e.g. viewer-only)", async () => {
    fakeAccess({ owned: false, sharedEditorPlus: false });
    expect(await userCanUseRemoteHost("user-3", "host-1")).toBe(false);
  });

  it("denies when the grants table has not been migrated yet", async () => {
    fakeAccess({ owned: false, grantsTableMissing: true });
    expect(await userCanUseRemoteHost("user-4", "host-1")).toBe(false);
  });

  it("denies without a userId or hostId (no query)", async () => {
    fakeAccess();
    expect(await userCanUseRemoteHost("", "host-1")).toBe(false);
    expect(await userCanUseRemoteHost("user-1", "")).toBe(false);
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe("shareRemoteHost / unshareRemoteHost", () => {
  it("inserts a workspace share idempotently", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await shareRemoteHost("host-1", "ws-1", "user-1");
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO workspace_remote_hosts/);
    expect(sql).toMatch(/ON CONFLICT \(workspace_id, remote_host_id\) DO NOTHING/);
    expect(params).toEqual(["ws-1", "host-1", "user-1"]);
  });

  it("deletes a workspace share", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await unshareRemoteHost("host-1", "ws-1");
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM workspace_remote_hosts/);
    expect(params).toEqual(["host-1", "ws-1"]);
  });
});
