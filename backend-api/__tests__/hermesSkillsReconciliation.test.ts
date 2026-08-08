// @ts-nocheck
const {
  HERMES_SKILLS_LOCK_FILE,
  computeMissingSavedHermesSkills,
  computeOrphanedInstalledHermesSkills,
  installedEntriesFromHermesLockData,
  isReservedHermesSkillName,
  isValidHermesSkillName,
  mergeHermesSkillState,
  normalizeSavedHermesSkillEntries,
  removeSavedHermesSkillEntry,
} = require("../../agent-runtime/lib/hermesSkillsReconciliation");

describe("hermes skill name validation", () => {
  it("accepts lockfile-style names", () => {
    for (const name of ["1password", "3-statement-model", "K8s", "a.b_c-d"]) {
      expect(isValidHermesSkillName(name)).toBe(true);
    }
  });

  it("rejects path-unsafe and empty names", () => {
    for (const name of ["", ".", "..", ".hidden", "a/b", "a b", "-lead", "a".repeat(65), null]) {
      expect(isValidHermesSkillName(name)).toBe(false);
    }
  });

  it("treats Nora-managed skill dirs as reserved, case-insensitively", () => {
    expect(isReservedHermesSkillName("nora-integrations")).toBe(true);
    expect(isReservedHermesSkillName("Nora-Integrations")).toBe(true);
    expect(isReservedHermesSkillName("github")).toBe(false);
  });
});

describe("saved-entry normalization", () => {
  it("deduplicates by name, drops invalid, reserved, and null entries", () => {
    const normalized = normalizeSavedHermesSkillEntries([
      { name: "github", ref: "official/dev/github" },
      { name: "github", ref: "duplicate/ref" },
      { name: "nora-integrations", ref: "sneaky/reserved" },
      { name: "bad/name", ref: "x" },
      { name: "", ref: "x" },
      null,
      { name: "notion", ref: "skills-sh/productivity/notion", source: "hermes-bundle" },
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toEqual(
      expect.objectContaining({
        name: "github",
        ref: "official/dev/github",
        source: "hermes-hub",
        installMode: "cli",
      }),
    );
    expect(normalized[1]).toEqual(
      expect.objectContaining({ name: "notion", source: "hermes-bundle" }),
    );
  });

  it("defaults unknown installMode/source values to cli/hermes-hub", () => {
    const [entry] = normalizeSavedHermesSkillEntries([
      { name: "github", ref: "r", installMode: "wat", source: "wat" },
    ]);
    expect(entry.installMode).toBe("cli");
    expect(entry.source).toBe("hermes-hub");
  });

  it("preserves a valid installedAt and replaces an invalid one", () => {
    const [kept] = normalizeSavedHermesSkillEntries([
      { name: "a1", installedAt: "2026-04-12T12:00:00.000Z" },
    ]);
    expect(kept.installedAt).toBe("2026-04-12T12:00:00.000Z");
    const [replaced] = normalizeSavedHermesSkillEntries([
      { name: "a2", installedAt: "not-a-date" },
    ]);
    expect(Number.isNaN(new Date(replaced.installedAt).getTime())).toBe(false);
  });
});

describe("lockfile parsing", () => {
  it("parses the hub lockfile installed map into entries", () => {
    const entries = installedEntriesFromHermesLockData({
      installed: {
        github: { version: "1.2.0", install_path: "dev/github" },
        "1password": { version: "0.9.1" },
      },
    });
    expect(entries).toEqual([
      { name: "github", version: "1.2.0", installPath: "dev/github" },
      { name: "1password", version: "0.9.1", installPath: "" },
    ]);
  });

  it("returns [] for malformed lock data and filters invalid names", () => {
    expect(installedEntriesFromHermesLockData(null)).toEqual([]);
    expect(installedEntriesFromHermesLockData({})).toEqual([]);
    expect(installedEntriesFromHermesLockData({ installed: [] })).toEqual([]);
    expect(installedEntriesFromHermesLockData({ installed: { "../evil": {} } })).toEqual([]);
  });

  it("exports the lockfile path under the skills dir", () => {
    expect(HERMES_SKILLS_LOCK_FILE).toBe("/opt/data/skills/.hub/lock.json");
  });
});

describe("drift computation", () => {
  const saved = [
    { name: "github", ref: "official/dev/github" },
    { name: "notion", ref: "skills-sh/productivity/notion" },
  ];

  it("finds saved skills missing from the runtime", () => {
    const missing = computeMissingSavedHermesSkills(saved, [{ name: "github" }]);
    expect(missing).toEqual([expect.objectContaining({ name: "notion" })]);
  });

  it("finds runtime skills Nora is not tracking", () => {
    const orphaned = computeOrphanedInstalledHermesSkills(saved, [
      { name: "github" },
      { name: "manual-tui-install", version: "2.0" },
    ]);
    expect(orphaned).toEqual([expect.objectContaining({ name: "manual-tui-install" })]);
  });

  it("removes a saved entry by name", () => {
    expect(removeSavedHermesSkillEntry(saved, "github")).toEqual([
      expect.objectContaining({ name: "notion" }),
    ]);
    expect(removeSavedHermesSkillEntry(saved, "")).toHaveLength(2);
  });
});

describe("mergeHermesSkillState", () => {
  it("derives healthy / missing_runtime / orphaned_runtime and sorts by name", () => {
    const merged = mergeHermesSkillState(
      [
        { name: "github", ref: "official/dev/github" },
        { name: "notion", ref: "skills-sh/productivity/notion" },
      ],
      [
        { name: "github", version: "1.2.0" },
        { name: "zulip", version: "0.1.0" },
      ],
    );

    expect(merged.map((row) => [row.name, row.status])).toEqual([
      ["github", "healthy"],
      ["notion", "missing_runtime"],
      ["zulip", "orphaned_runtime"],
    ]);
    expect(merged[0]).toEqual(
      expect.objectContaining({ saved: true, installed: true, version: "1.2.0" }),
    );
    expect(merged[2]).toEqual(expect.objectContaining({ saved: false, installed: true }));
  });

  it("lets pending jobs win over steady-state statuses", () => {
    const merged = mergeHermesSkillState(
      [{ name: "github", ref: "official/dev/github" }],
      [{ name: "zulip" }],
      [
        { name: "github", operation: "install" },
        { name: "zulip", operation: "delete" },
      ],
    );
    expect(merged.map((row) => [row.name, row.status])).toEqual([
      ["github", "pending_install"],
      ["zulip", "pending_delete"],
    ]);
  });

  it("never surfaces reserved Nora-managed skills from saved state", () => {
    const merged = mergeHermesSkillState([{ name: "nora-integrations", ref: "x" }], []);
    expect(merged).toEqual([]);
  });
});
