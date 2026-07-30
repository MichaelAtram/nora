import assert from "node:assert/strict";
import test from "node:test";

import {
  agentSkillRowToInstalledRow,
  applyPendingJobOverlay,
  browseSummaryToCardSkill,
  computeInstalledNames,
  computeInstalledRefs,
  computeLibraryRefs,
  formatHermesTrustLevel,
  installedSectionRows,
  isJobActive,
  type HermesAgentSkillRow,
} from "./hermesSkillsView";

function row(overrides: Partial<HermesAgentSkillRow> = {}): HermesAgentSkillRow {
  return {
    name: "1password",
    version: "1.0.0",
    saved: true,
    installed: true,
    source: "hermes-hub",
    ref: "official/security/1password",
    installMode: "cli",
    installedAt: "2026-07-01T00:00:00.000Z",
    status: "healthy",
    ...overrides,
  };
}

test("browse summaries map ref to slug with null counts so SkillCard hides stats", () => {
  const card = browseSummaryToCardSkill({
    ref: "official/security/1password",
    name: "1password",
    description: "Manage 1Password items.",
    source: "official",
    trustLevel: "builtin",
    tags: ["security"],
  });

  assert.deepEqual(card, {
    slug: "official/security/1password",
    name: "1password",
    description: "Manage 1Password items.",
    downloads: null,
    stars: null,
    updatedAt: null,
  });
});

test("browse summaries fall back to the ref as name and a neutral description", () => {
  const card = browseSummaryToCardSkill({ ref: "community/foo/bar" });
  assert.equal(card.name, "community/foo/bar");
  assert.equal(card.description, "No description provided.");
});

test("agent skill rows gain slug=name and surface the ref as pagePath", () => {
  const mapped = agentSkillRowToInstalledRow(row());
  assert.equal(mapped.slug, "1password");
  assert.equal(mapped.author, "");
  assert.equal(mapped.pagePath, "official/security/1password");
  assert.equal(mapped.status, "healthy");
  assert.equal(mapped.version, "1.0.0");
});

test("orphaned rows without a ref map to an empty pagePath (panel falls back to slug)", () => {
  const mapped = agentSkillRowToInstalledRow(
    row({ name: "mystery", ref: "", saved: false, status: "orphaned_runtime", version: "" }),
  );
  assert.equal(mapped.slug, "mystery");
  assert.equal(mapped.pagePath, "");
  assert.equal(mapped.version, "");
});

test("active install jobs overlay pending_install; delete jobs overlay pending_delete", () => {
  const rows = [row(), row({ name: "k8s", ref: "openai/skills/k8s" })];
  const overlaid = applyPendingJobOverlay(rows, {
    "1password": { operation: "delete", status: "running" },
    k8s: { operation: "install", status: "pending" },
  });

  assert.equal(overlaid[0].status, "pending_delete");
  assert.equal(overlaid[1].status, "pending_install");
});

test("finished or unknown jobs leave row status untouched", () => {
  const rows = [row(), row({ name: "k8s", ref: "openai/skills/k8s", status: "missing_runtime" })];
  const overlaid = applyPendingJobOverlay(rows, {
    "1password": { operation: "install", status: "success" },
    other: { operation: "install", status: "running" },
  });

  assert.equal(overlaid[0].status, "healthy");
  assert.equal(overlaid[1].status, "missing_runtime");
});

test("isJobActive is true only for pending/running jobs", () => {
  assert.equal(isJobActive({ operation: "install", status: "pending" }), true);
  assert.equal(isJobActive({ operation: "delete", status: "running" }), true);
  assert.equal(isJobActive({ operation: "install", status: "success" }), false);
  assert.equal(isJobActive({ operation: "install", status: "failed" }), false);
  assert.equal(isJobActive(null), false);
  assert.equal(isJobActive(undefined), false);
});

test("installed names include only rows present on the runtime", () => {
  const names = computeInstalledNames([
    row(),
    row({ name: "gone", installed: false, status: "missing_runtime" }),
  ]);
  assert.deepEqual([...names], ["1password"]);
});

test("installed refs badge browse cards and skip ref-less orphans", () => {
  const refs = computeInstalledRefs([
    row(),
    row({ name: "orphan", ref: "", saved: false, status: "orphaned_runtime" }),
    row({ name: "gone", ref: "openai/skills/gone", installed: false, status: "missing_runtime" }),
  ]);
  assert.deepEqual([...refs], ["official/security/1password"]);
});

test("library refs collect the pinned registry identifiers", () => {
  const refs = computeLibraryRefs([
    { id: "a", ref: "official/security/1password", name: "1password" },
    { id: "b", ref: "openai/skills/k8s", name: "k8s" },
    { id: "c", ref: "" },
  ]);
  assert.deepEqual([...refs], ["official/security/1password", "openai/skills/k8s"]);
});

test("installed section keeps installed, orphaned, and pending-delete rows only", () => {
  const rows = [
    row(),
    row({ name: "orphan", ref: "", saved: false, status: "orphaned_runtime", installed: true }),
    row({ name: "deleting", status: "pending_delete", installed: false }),
    row({ name: "gone", installed: false, status: "missing_runtime" }),
  ];
  assert.deepEqual(
    installedSectionRows(rows).map((entry) => entry.name),
    ["1password", "orphan", "deleting"],
  );
});

test("trust levels display capitalized and tolerate missing values", () => {
  assert.equal(formatHermesTrustLevel("community"), "Community");
  assert.equal(formatHermesTrustLevel("builtin"), "Builtin");
  assert.equal(formatHermesTrustLevel(""), "");
  assert.equal(formatHermesTrustLevel(undefined), "");
});
