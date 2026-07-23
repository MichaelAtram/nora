// @ts-nocheck
const db = require("./db");
const { runContainerCommand } = require("./authSync");
const containerManager = require("./containerManager");
const {
  isValidHermesProfileName,
  resolveHermesProfileHome,
  buildHermesProfileGatewayStartSnippet,
  buildHermesProfileGatewayStopSnippet,
} = require("../agent-runtime/lib/hermesRuntimeBootstrap");

const HERMES_BIN_PREAMBLE = [
  'HERMES_BIN="/opt/hermes/.venv/bin/hermes"',
  '[ -x "$HERMES_BIN" ] || HERMES_BIN="$(command -v hermes 2>/dev/null || true)"',
].join("\n");

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertProfileManagementSupported(agent) {
  if (typeof containerManager.isKubernetesAgent === "function" && containerManager.isKubernetesAgent(agent)) {
    throw statusError("Hermes profile management is not supported on Kubernetes agents yet", 409);
  }
}

// Enumerate on-disk profiles + pidfile liveness via a tiny shell probe.
async function readOnDiskProfiles(agent) {
  const command = [
    "set -eu",
    'root="/opt/data/profiles"',
    'first=1',
    'printf "{\\"profiles\\":["',
    'if [ -d "$root" ]; then',
    '  for d in "$root"/*/; do',
    '    [ -d "$d" ] || continue',
    '    name="$(basename "$d")"',
    '    running=false',
    '    if [ -f "$d/gateway.pid" ] && kill -0 "$(cat "$d/gateway.pid")" 2>/dev/null; then running=true; fi',
    '    if [ "$first" -eq 0 ]; then printf ","; fi',
    '    printf "{\\"name\\":\\"%s\\",\\"running\\":%s}" "$name" "$running"',
    '    first=0',
    '  done',
    "fi",
    'printf "]}"',
  ].join("\n");
  let result;
  try {
    result = await runContainerCommand(agent, command, { timeout: 15000 });
  } catch {
    return { profiles: [] };
  }
  try {
    return JSON.parse(String(result?.output || "").trim() || '{"profiles":[]}');
  } catch {
    return { profiles: [] };
  }
}

async function listHermesProfiles(agent) {
  const [onDisk, registry] = await Promise.all([
    readOnDiskProfiles(agent),
    db.query(
      "SELECT name, display_name, is_default FROM hermes_profiles WHERE agent_id = $1",
      [agent.id],
    ),
  ]);

  const byName = new Map();
  byName.set("default", { name: "default", displayName: "Default", isDefault: true, running: true });

  for (const row of registry.rows || []) {
    byName.set(row.name, {
      name: row.name,
      displayName: row.display_name || row.name,
      isDefault: Boolean(row.is_default),
      running: row.name === "default",
    });
  }
  for (const p of onDisk.profiles || []) {
    const existing = byName.get(p.name) || { name: p.name, displayName: p.name, isDefault: false };
    byName.set(p.name, { ...existing, running: Boolean(p.running) });
    // Auto-register out-of-band profiles Nora didn't create. Never auto-register "default" —
    // it's a seeded synthetic entry, not a real registry row.
    if (p.name !== "default" && !(registry.rows || []).some((r) => r.name === p.name)) {
      await db.query(
        `INSERT INTO hermes_profiles(agent_id, name, display_name, is_default)
         VALUES($1, $2, $2, FALSE) ON CONFLICT (agent_id, name) DO NOTHING`,
        [agent.id, p.name],
      );
    }
  }

  // The default profile always exists and is always the default, regardless of what the
  // registry or on-disk probe reported (a stray "default" row/dir must not override this).
  byName.set("default", { name: "default", displayName: "Default", isDefault: true, running: true });

  return { profiles: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

async function assertProfileExists(agent, name) {
  if (name === "default") return;
  const { profiles } = await listHermesProfiles(agent);
  if (!profiles.some((p) => p.name === name)) {
    throw statusError(`Unknown Hermes profile: ${name}`, 404);
  }
}

async function createHermesProfile(agent, name, { cloneFrom } = {}) {
  assertProfileManagementSupported(agent);
  if (name === "default") throw statusError("'default' is reserved", 400);
  if (!isValidHermesProfileName(name)) throw statusError(`Invalid profile name: ${name}`, 400);

  const dup = await db.query(
    "SELECT 1 FROM hermes_profiles WHERE agent_id = $1 AND name = $2",
    [agent.id, name],
  );
  if (dup.rows[0]) throw statusError(`Profile ${name} already exists`, 409);

  const cloneArg = cloneFrom && isValidHermesProfileName(cloneFrom) && cloneFrom !== "default"
    ? ` --clone-from ${cloneFrom}`
    : "";
  const home = resolveHermesProfileHome(name);
  const command = [
    "set -eu",
    HERMES_BIN_PREAMBLE,
    `"$HERMES_BIN" profile create ${name}${cloneArg}`,
    buildHermesProfileGatewayStartSnippet(home),
  ].join("\n");
  await runContainerCommand(agent, command, { timeout: 60000 });

  await db.query(
    `INSERT INTO hermes_profiles(agent_id, name, display_name, is_default)
     VALUES($1, $2, $2, FALSE) ON CONFLICT (agent_id, name) DO NOTHING`,
    [agent.id, name],
  );

  return { profile: { name, displayName: name, isDefault: false, running: true } };
}

async function deleteHermesProfile(agent, name) {
  assertProfileManagementSupported(agent);
  if (name === "default") throw statusError("The default profile cannot be deleted", 400);
  if (!isValidHermesProfileName(name)) throw statusError(`Invalid profile name: ${name}`, 400);

  const home = resolveHermesProfileHome(name);
  const command = [
    "set -eu",
    HERMES_BIN_PREAMBLE,
    buildHermesProfileGatewayStopSnippet(home),
    `"$HERMES_BIN" profile delete ${name} --yes 2>/dev/null || "$HERMES_BIN" profile delete ${name} || true`,
  ].join("\n");
  await runContainerCommand(agent, command, { timeout: 60000 });

  await db.query("DELETE FROM hermes_runtime_state WHERE agent_id = $1 AND profile_name = $2", [agent.id, name]);
  await db.query("DELETE FROM hermes_profiles WHERE agent_id = $1 AND name = $2", [agent.id, name]);

  return listHermesProfiles(agent);
}

async function setProfileGatewayState(agent, name, action) {
  assertProfileManagementSupported(agent);
  if (name === "default") throw statusError("The default profile gateway is managed by the runtime", 400);
  await assertProfileExists(agent, name);
  const home = resolveHermesProfileHome(name);
  const parts = ["set -eu", HERMES_BIN_PREAMBLE];
  if (action === "stop" || action === "restart") parts.push(buildHermesProfileGatewayStopSnippet(home));
  if (action === "start" || action === "restart") parts.push(buildHermesProfileGatewayStartSnippet(home));
  if (parts.length === 2) throw statusError(`Unknown gateway action: ${action}`, 400);
  await runContainerCommand(agent, parts.join("\n"), { timeout: 30000 });
  return listHermesProfiles(agent);
}

module.exports = {
  listHermesProfiles,
  createHermesProfile,
  deleteHermesProfile,
  setProfileGatewayState,
  assertProfileExists,
  assertProfileManagementSupported,
};
