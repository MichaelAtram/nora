// @ts-nocheck
const mockDb = { query: jest.fn() };
const mockRunContainerCommand = jest.fn();
const mockIsKubernetesAgent = jest.fn(() => false);

jest.mock("../db", () => mockDb);
jest.mock("../authSync", () => ({ runContainerCommand: mockRunContainerCommand }));
jest.mock("../containerManager", () => ({ isKubernetesAgent: mockIsKubernetesAgent }));

const {
  listHermesProfiles,
  createHermesProfile,
  deleteHermesProfile,
  setProfileGatewayState,
} = require("../hermesProfiles");

const agent = { id: "agent-1", container_id: "c1" };

beforeEach(() => {
  mockDb.query.mockReset();
  mockRunContainerCommand.mockReset();
  mockIsKubernetesAgent.mockReturnValue(false);
});

describe("createHermesProfile", () => {
  it("rejects the reserved 'default' name", async () => {
    await expect(createHermesProfile(agent, "default")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects invalid slugs", async () => {
    await expect(createHermesProfile(agent, "Bad Name")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("creates the profile via CLI, registers it, and starts its gateway", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // duplicate check
      .mockResolvedValueOnce({ rows: [] }); // insert
    mockRunContainerCommand.mockResolvedValue({ output: "{}" });
    await createHermesProfile(agent, "coder");
    const commands = mockRunContainerCommand.mock.calls.map(([, cmd]) => cmd).join("\n");
    expect(commands).toContain("profile create coder");
    expect(commands).toContain("gateway run");
    const insert = mockDb.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO hermes_profiles"));
    expect(insert[1]).toEqual(expect.arrayContaining(["agent-1", "coder"]));
  });
});

describe("deleteHermesProfile", () => {
  it("refuses to delete default", async () => {
    await expect(deleteHermesProfile(agent, "default")).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("listHermesProfiles", () => {
  it("always includes default and merges on-disk + registry", async () => {
    // on-disk enumeration returns coder; registry has coder + davids-pa (davids-pa off-disk)
    mockRunContainerCommand.mockResolvedValue({
      output: JSON.stringify({ profiles: [{ name: "coder", running: true }] }),
    });
    mockDb.query.mockResolvedValue({
      rows: [{ name: "coder", display_name: "Coder", is_default: false }],
    });
    const { profiles } = await listHermesProfiles(agent);
    const names = profiles.map((p) => p.name).sort();
    expect(names).toContain("default");
    expect(names).toContain("coder");
    expect(profiles.find((p) => p.name === "default").isDefault).toBe(true);
  });

  it("still lists a registry-only profile that is not present on disk", async () => {
    mockRunContainerCommand.mockResolvedValue({ output: JSON.stringify({ profiles: [] }) });
    mockDb.query.mockResolvedValue({
      rows: [{ name: "ghost", display_name: "Ghost", is_default: false }],
    });
    const { profiles } = await listHermesProfiles(agent);
    expect(profiles.map((p) => p.name)).toContain("ghost");
  });

  it("auto-registers an on-disk profile that is not yet in the registry", async () => {
    mockRunContainerCommand.mockResolvedValue({
      output: JSON.stringify({ profiles: [{ name: "shadow", running: true }] }),
    });
    mockDb.query.mockResolvedValue({ rows: [] });
    await listHermesProfiles(agent);
    const insertCall = mockDb.query.mock.calls.find(
      ([sql, params]) => sql.includes("INSERT INTO hermes_profiles") && params.includes("shadow"),
    );
    expect(insertCall).toBeTruthy();
  });

  it("does not auto-register an on-disk directory named 'default'", async () => {
    mockRunContainerCommand.mockResolvedValue({
      output: JSON.stringify({ profiles: [{ name: "default", running: true }] }),
    });
    mockDb.query.mockResolvedValue({ rows: [] });
    await listHermesProfiles(agent);
    const insertForDefault = mockDb.query.mock.calls.find(
      ([sql, params]) => sql.includes("INSERT INTO hermes_profiles") && params && params.includes("default"),
    );
    expect(insertForDefault).toBeUndefined();
  });

  it("still reports default as isDefault:true even if the registry says otherwise", async () => {
    mockRunContainerCommand.mockResolvedValue({ output: JSON.stringify({ profiles: [] }) });
    mockDb.query.mockResolvedValue({
      rows: [{ name: "default", display_name: "Default", is_default: false }],
    });
    const { profiles } = await listHermesProfiles(agent);
    const def = profiles.find((p) => p.name === "default");
    expect(def.isDefault).toBe(true);
  });

  it("degrades to registry-only when the on-disk probe throws", async () => {
    mockRunContainerCommand.mockRejectedValue(new Error("exec failed"));
    mockDb.query.mockResolvedValue({
      rows: [{ name: "coder", display_name: "Coder", is_default: false }],
    });
    const { profiles } = await listHermesProfiles(agent);
    const names = profiles.map((p) => p.name).sort();
    expect(names).toEqual(["coder", "default"]);
  });
});

describe("Kubernetes guard", () => {
  beforeEach(() => {
    mockIsKubernetesAgent.mockReturnValue(true);
  });

  it("createHermesProfile rejects with 409 and never runs the CLI", async () => {
    await expect(createHermesProfile(agent, "coder")).rejects.toMatchObject({ statusCode: 409 });
    expect(mockRunContainerCommand).not.toHaveBeenCalled();
  });

  it("deleteHermesProfile rejects with 409 and never runs the CLI", async () => {
    await expect(deleteHermesProfile(agent, "coder")).rejects.toMatchObject({ statusCode: 409 });
    expect(mockRunContainerCommand).not.toHaveBeenCalled();
  });

  it("setProfileGatewayState rejects with 409 and never runs the CLI", async () => {
    await expect(setProfileGatewayState(agent, "coder", "start")).rejects.toMatchObject({ statusCode: 409 });
    expect(mockRunContainerCommand).not.toHaveBeenCalled();
  });
});
