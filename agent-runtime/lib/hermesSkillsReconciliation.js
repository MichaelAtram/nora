// Desired-vs-actual reconciliation contracts for Hermes runtime skills.
//
// Deliberately a parallel module to clawhubReconciliation.js rather than a
// shared engine: both live in the mounted agent-runtime blast-radius zone, and
// the two families differ in identity (ClawHub keys on author+slug from its
// own lockfile; Hermes keys on the skill NAME from the Hermes hub lockfile at
// $HERMES_HOME/skills/.hub/lock.json, whose entries may nest under category
// folders via install_path). The status vocabulary and row shape are kept
// IDENTICAL to the ClawHub module so the dashboard's shared skill components
// render both families: healthy / missing_runtime / orphaned_runtime /
// pending_install / pending_delete.

// Container-absolute paths for the Hermes hub skills tree. get_hermes_home()
// honors HERMES_HOME (=/opt/data in Nora containers and the stock image), so
// hub skills live at /opt/data/skills — NOT under $HOME/.hermes (that is the
// separate "local" tier where Nora's generated nora-integrations skill lives).
// Verified against nousresearch/hermes-agent:latest (2026-07-30 smoke).
const HERMES_SKILLS_DIR = "/opt/data/skills";
const HERMES_SKILLS_LOCK_FILE = `${HERMES_SKILLS_DIR}/.hub/lock.json`;

// Skill directories Nora itself manages. These are written by the integrations
// reconciler as plain folders (never hub-lock entries, so they cannot surface
// as orphaned_runtime), but install/delete requests naming them must still be
// refused everywhere: deleting one would race the integrations reconciler.
const NORA_MANAGED_HERMES_SKILL_DIRS = ["nora-integrations"];

// The lockfile skill name doubles as the `hermes skills uninstall <name>`
// argument and appears in shell commands, so it is validated at this single
// choke point. Leading alphanumeric excludes "." / ".." and hidden names; the
// charset excludes path separators and whitespace.
const HERMES_SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function isValidHermesSkillName(name) {
  return HERMES_SKILL_NAME_RE.test(String(name || ""));
}

function isReservedHermesSkillName(name) {
  return NORA_MANAGED_HERMES_SKILL_DIRS.includes(
    String(name || "")
      .trim()
      .toLowerCase(),
  );
}

function normalizeSavedHermesSkillEntry(name, entry = {}) {
  const skillName = String(entry?.name || name || "").trim();
  if (!isValidHermesSkillName(skillName) || isReservedHermesSkillName(skillName)) {
    return null;
  }

  const ref = String(entry?.ref || "").trim();
  const source = entry?.source === "hermes-bundle" ? "hermes-bundle" : "hermes-hub";
  const installMode = entry?.installMode === "files" ? "files" : "cli";
  const installedAtRaw = String(entry?.installedAt || "").trim();
  const installedAt =
    installedAtRaw && !Number.isNaN(new Date(installedAtRaw).getTime())
      ? new Date(installedAtRaw).toISOString()
      : new Date().toISOString();

  return {
    source,
    ref,
    name: skillName,
    installMode,
    installedAt,
  };
}

function normalizeSavedHermesSkillEntries(entries = []) {
  const deduped = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizeSavedHermesSkillEntry(entry?.name, entry);
    if (!normalized) continue;
    if (!deduped.has(normalized.name)) {
      deduped.set(normalized.name, normalized);
    }
  }
  return [...deduped.values()];
}

function normalizeInstalledHermesSkillEntries(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      name: String(entry?.name || "").trim(),
      version: String(entry?.version || "").trim(),
      installPath: String(entry?.installPath || entry?.install_path || "").trim(),
    }))
    .filter((entry) => isValidHermesSkillName(entry.name));
}

// Parse the Hermes hub lockfile ({"installed": {<name>: {...entry}}}) into
// installed-entry rows. Shared by the worker (provisioner exec read) and the
// backend route (runContainerCommand read) so both interpret the runtime's
// actual state identically. Malformed content yields [] rather than throwing —
// callers treat an unreadable lockfile as "nothing installed" plus a warning.
function installedEntriesFromHermesLockData(data) {
  const installed = data && typeof data === "object" ? data.installed : null;
  if (!installed || typeof installed !== "object" || Array.isArray(installed)) {
    return [];
  }
  return normalizeInstalledHermesSkillEntries(
    Object.entries(installed).map(([name, entry]) => ({
      name,
      version: entry?.version,
      installPath: entry?.install_path,
    })),
  );
}

function computeMissingSavedHermesSkills(savedSkills = [], installedSkills = []) {
  const normalizedSaved = normalizeSavedHermesSkillEntries(savedSkills);
  const installedNames = new Set(
    normalizeInstalledHermesSkillEntries(installedSkills).map((entry) => entry.name),
  );
  return normalizedSaved.filter((entry) => !installedNames.has(entry.name));
}

function computeOrphanedInstalledHermesSkills(savedSkills = [], installedSkills = []) {
  const normalizedSaved = normalizeSavedHermesSkillEntries(savedSkills);
  const savedNames = new Set(normalizedSaved.map((entry) => entry.name));
  return normalizeInstalledHermesSkillEntries(installedSkills).filter(
    (entry) => !savedNames.has(entry.name),
  );
}

function removeSavedHermesSkillEntry(entries = [], name) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    return normalizeSavedHermesSkillEntries(entries);
  }
  return normalizeSavedHermesSkillEntries(entries).filter((entry) => entry.name !== normalizedName);
}

/**
 * Merge Nora's saved Hermes skill entries, the runtime hub-lockfile view, and
 * any in-flight jobs into one operator-facing skill list.
 *
 * Drift is surfaced, never hidden: `healthy` means saved+installed match,
 * `missing_runtime` means Nora expects the skill but the runtime lacks it
 * (e.g. a Docker redeploy rebuilt /opt/data), and `orphaned_runtime` means the
 * runtime has a hub-installed skill Nora is not tracking (e.g. installed via
 * the agent's own TUI). Pending install/delete jobs win over steady-state
 * statuses so the UI can show transitional state.
 *
 * @param {Array<object>} [savedSkills=[]] Saved entries from `agents.hermes_skills`.
 * @param {Array<object>} [installedSkills=[]] Hub-lockfile entries currently installed.
 * @param {Array<object>} [pendingJobs=[]] In-flight skill jobs keyed by `name`.
 * @returns {Array<object>} Sorted merged rows with a derived `status`.
 */
function mergeHermesSkillState(savedSkills = [], installedSkills = [], pendingJobs = []) {
  const normalizedSaved = normalizeSavedHermesSkillEntries(savedSkills);
  const normalizedInstalled = normalizeInstalledHermesSkillEntries(installedSkills);
  const installedByName = new Map(normalizedInstalled.map((entry) => [entry.name, entry]));
  const pendingByName = new Map(
    (Array.isArray(pendingJobs) ? pendingJobs : [])
      .map((job) => [String(job?.name || "").trim(), job])
      .filter(([name]) => name),
  );
  const merged = [];

  for (const saved of normalizedSaved) {
    const installed = installedByName.get(saved.name);
    const pending = pendingByName.get(saved.name);
    merged.push({
      name: saved.name,
      version: installed?.version || "",
      saved: true,
      installed: Boolean(installed),
      source: saved.source,
      ref: saved.ref,
      installMode: saved.installMode,
      installedAt: saved.installedAt || null,
      status:
        pending?.operation === "delete"
          ? "pending_delete"
          : pending?.operation === "install"
            ? "pending_install"
            : installed
              ? "healthy"
              : "missing_runtime",
    });
    installedByName.delete(saved.name);
  }

  for (const installed of installedByName.values()) {
    const pending = pendingByName.get(installed.name);
    merged.push({
      name: installed.name,
      version: installed.version || "",
      saved: false,
      installed: true,
      source: "hermes-hub",
      ref: "",
      installMode: "cli",
      installedAt: null,
      status: pending?.operation === "delete" ? "pending_delete" : "orphaned_runtime",
    });
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  HERMES_SKILLS_DIR,
  HERMES_SKILLS_LOCK_FILE,
  NORA_MANAGED_HERMES_SKILL_DIRS,
  computeMissingSavedHermesSkills,
  computeOrphanedInstalledHermesSkills,
  installedEntriesFromHermesLockData,
  isReservedHermesSkillName,
  isValidHermesSkillName,
  mergeHermesSkillState,
  normalizeInstalledHermesSkillEntries,
  normalizeSavedHermesSkillEntries,
  normalizeSavedHermesSkillEntry,
  removeSavedHermesSkillEntry,
};
