// @ts-nocheck
// Remote-host registry — Phase A of the Bring-Your-Own-Compute epic.
//
// Mirrors kubernetesClusters.ts: a registry of operator-owned remote machines
// (normally a Linux Docker server, VPS, or cloud VM) that Nora can reach over
// SSH to run the Docker adapter. A registered host surfaces as the execution
// target `remote:<id>`,
// the same way a Kubernetes cluster surfaces as `k8s:<id>`. SSH credentials are
// encrypted at rest with the shared AES-256-GCM helper.
//
// This module centralizes registry persistence, credential encryption, address
// validation, and mutation locks. Runtime adapters and the gateway consume its
// secret-bearing and masked profile APIs.

const db = require("./db");
const { decrypt, encrypt, ensureEncryptionConfigured } = require("./crypto");
const { Client } = require("pg");
const { buildPostgresConfig } = require("./lib/connectionConfig");
const dns = require("node:dns").promises;
const net = require("node:net");
const { PRIVATE_IP_RE } = require("./networkSafety");

const AUTH_MODES = new Set(["key", "password"]);
const DEFAULT_SSH_PORT = 22;
const DEFAULT_TEST_TIMEOUT_MS = 10000;
const DEFAULT_MUTATION_LOCK_TIMEOUT_MS = 15000;
const MUTATION_LOCK_POLL_MS = 50;
const DOCKER_VERSION_PROBE = "docker version --format '{{.Server.Version}}'";
const REMOTE_HOSTNAME_RE = /^[A-Za-z0-9._-]+$/;
const REMOTE_HOST_MUTATION_LOCK_PREFIX = "nora:remote-host-mutation:";

let sshClientCtor = null;

function getSshClientCtor() {
  if (!sshClientCtor) {
    sshClientCtor = require("ssh2").Client;
  }
  return sshClientCtor;
}

// Input normalization and profile serialization

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPaaSMode() {
  return (
    String(process.env.PLATFORM_MODE || "selfhosted")
      .trim()
      .toLowerCase() === "paas"
  );
}

function assertRemoteHostsSupported() {
  if (!isPaaSMode()) return;
  const error = new Error(
    "Remote Docker hosts are disabled in hosted mode because agent runtime traffic is not end-to-end encrypted; use a self-hosted Nora control plane on the same private network",
  );
  error.statusCode = 403;
  error.code = "REMOTE_HOSTS_DISABLED_IN_PAAS";
  throw error;
}

function normalizeRemoteAddress(value, label) {
  const host = normalizeText(value);
  if (!host) return "";
  if (host.length > 253 || (!net.isIP(host) && !REMOTE_HOSTNAME_RE.test(host))) {
    const error = new Error(
      `${label} must be a plain hostname or IP address without a scheme or port`,
    );
    error.statusCode = 400;
    throw error;
  }
  return host;
}

function isUnroutableRemoteAddress(address) {
  const normalized = String(address || "")
    .trim()
    .toLowerCase();
  if (PRIVATE_IP_RE.test(normalized)) return true;
  if (normalized.startsWith("ff")) return true;
  if (net.isIP(normalized) === 4) {
    const first = Number.parseInt(normalized.split(".")[0], 10);
    return first >= 224;
  }
  return false;
}

async function resolveRemoteAddressForRuntime(value, label, { publicOnly = isPaaSMode() } = {}) {
  const host = normalizeRemoteAddress(value, label);
  if (!host) return "";
  if (net.isIP(host)) {
    if (publicOnly && isUnroutableRemoteAddress(host)) {
      const error = new Error(`${label} must use a public address in hosted mode`);
      error.statusCode = 400;
      throw error;
    }
    return host;
  }
  if (!publicOnly) return host;

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (error) {
    const validationError = new Error(
      `${label} hostname ${host} could not be resolved (${error.code || error.message})`,
    );
    validationError.statusCode = 400;
    throw validationError;
  }
  const unsafe = addresses.find((entry) => isUnroutableRemoteAddress(entry.address));
  if (unsafe) {
    const error = new Error(
      `${label} must resolve only to public addresses in hosted mode (${unsafe.address} is private or unroutable)`,
    );
    error.statusCode = 400;
    throw error;
  }
  if (!addresses[0]?.address) {
    const error = new Error(`${label} hostname ${host} did not resolve to an address`);
    error.statusCode = 400;
    throw error;
  }
  // Hosted-mode callers use the validated IP directly, closing the DNS
  // rebinding window between registry lookup and SSH/readiness/proxy traffic.
  return addresses[0].address;
}

async function resolveRemoteHostRuntimeProfile(profile) {
  if (!profile) return null;
  const rawSshHost = profile.sshHost;
  const rawGatewayHost = profile.gatewayHost || profile.sshHost;
  const [sshHost, gatewayHost] = await Promise.all([
    resolveRemoteAddressForRuntime(rawSshHost, "Remote SSH host"),
    resolveRemoteAddressForRuntime(rawGatewayHost, "Remote gateway address"),
  ]);
  return { ...profile, rawSshHost, rawGatewayHost, sshHost, gatewayHost };
}

function normalizeSlug(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function normalizeHostId(value, fallbackLabel = "") {
  const normalized = normalizeSlug(value) || normalizeSlug(fallbackLabel);
  if (!normalized) {
    const error = new Error("Remote host id is required");
    error.statusCode = 400;
    throw error;
  }
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(normalized)) {
    const error = new Error("Remote host id must be 2-64 lowercase letters, numbers, or dashes");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function requireRemoteHostOwnerUserId(value) {
  const ownerUserId = normalizeText(value);
  if (ownerUserId) return ownerUserId;
  const error = new Error("Remote host owner is required");
  error.statusCode = 400;
  error.code = "REMOTE_HOST_OWNER_REQUIRED";
  throw error;
}

function createRemoteHostNotFoundError() {
  const error = new Error("Remote host not found");
  error.statusCode = 404;
  return error;
}

function remoteHostMutationLockKey(hostId) {
  return `${REMOTE_HOST_MUTATION_LOCK_PREFIX}${normalizeHostId(hostId)}`;
}

function remoteHostMutationLockTimeoutMs() {
  const configured = Number.parseInt(process.env.REMOTE_HOST_MUTATION_LOCK_TIMEOUT_MS || "", 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MUTATION_LOCK_TIMEOUT_MS;
}

function waitForMutationLockPoll(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRemoteHostMutationClient() {
  const {
    max: _max,
    min: _min,
    idleTimeoutMillis: _idleTimeoutMillis,
    ...clientConfig
  } = buildPostgresConfig({
    ...process.env,
    DB_APPLICATION_NAME: "nora-backend-remote-host-mutation",
  });
  return new Client(clientConfig);
}

async function withRemoteHostMutationLock(hostId, operation) {
  const lockKey = remoteHostMutationLockKey(hostId);
  const client = createRemoteHostMutationClient();
  let connected = false;
  let lockHeld = false;
  try {
    await client.connect();
    connected = true;
    const timeoutMs = remoteHostMutationLockTimeoutMs();
    const deadline = Date.now() + timeoutMs;
    while (!lockHeld) {
      const acquired = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [lockKey],
      );
      lockHeld = Boolean(acquired.rows[0]?.locked);
      if (lockHeld) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const error = new Error(
          `Another remote host operation is still active for ${normalizeHostId(hostId)}`,
        );
        error.statusCode = 409;
        error.code = "REMOTE_HOST_MUTATION_LOCK_TIMEOUT";
        throw error;
      }
      await waitForMutationLockPoll(Math.min(MUTATION_LOCK_POLL_MS, remaining));
    }
    return await operation();
  } finally {
    if (lockHeld) {
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
        .catch((error) =>
          console.warn(
            `[remoteHosts] advisory unlock failed for host ${normalizeHostId(hostId)}: ${error.message}`,
          ),
        );
    }
    if (connected) {
      await client
        .end()
        .catch((error) =>
          console.warn(
            `[remoteHosts] mutation lock connection close failed for host ${normalizeHostId(hostId)}: ${error.message}`,
          ),
        );
    }
  }
}

// `remote:<id>` execution-target identifiers. Self-contained so this module
// does not depend on backendCatalog recognizing the `remote-docker` target yet.
function normalizeRemoteExecutionTargetId(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (!normalized.startsWith("remote:")) return null;
  const hostId = normalizeSlug(normalized.slice("remote:".length));
  return hostId ? `remote:${hostId}` : null;
}

function isRemoteDockerTarget(value) {
  const normalized = normalizeText(value).toLowerCase();
  return (
    normalized === "remote-docker" || normalized === "remote" || normalized.startsWith("remote:")
  );
}

function isRemoteDockerAgent(agent = {}) {
  return [
    agent.deploy_target,
    agent.deployTarget,
    agent.backend_type,
    agent.backendType,
    agent.execution_target_id,
    agent.executionTargetId,
  ].some((value) => isRemoteDockerTarget(value));
}

function createRemoteHostAccessRevokedError() {
  const error = new Error(
    "Remote Docker host access has been revoked; stop or delete the agent, or ask the host owner to share the host again",
  );
  error.statusCode = 403;
  error.code = "REMOTE_HOST_ACCESS_REVOKED";
  return error;
}

function createRemoteHostRetestRequiredError(host) {
  const error = new Error(
    `${host?.label || "Remote Docker host"} must pass Test before Nora can use it again`,
  );
  error.statusCode = 409;
  error.code = "REMOTE_HOST_RETEST_REQUIRED";
  return error;
}

function createRemoteHostCleanupPinRequiredError(host) {
  const error = new Error(
    `Cannot safely clean up Remote Docker runtime on ${host?.label || host?.id || "the registered host"}: ` +
      "the SSH host-key pin is missing. Nora refused the connection because accepting an unknown key " +
      "could send cleanup credentials or destructive Docker commands to an impersonated host. The " +
      "runtime may still be running; verify the host out of band, restore a trusted pin with Test where " +
      "available, or remove the runtime manually on the verified host.",
  );
  error.statusCode = 409;
  error.code = "REMOTE_HOST_CLEANUP_PIN_REQUIRED";
  error.orphanRisk = true;
  return error;
}

function toPublicRemoteHostAuthorizationError(error) {
  if (
    isRemoteHostAccessRevokedError(error) ||
    error?.code === "REMOTE_HOST_RETEST_REQUIRED" ||
    error?.code === "REMOTE_HOST_AUTH_CHECK_FAILED"
  ) {
    return error;
  }
  const publicError = new Error("Unable to verify Remote Docker host access");
  publicError.statusCode = 503;
  publicError.code = "REMOTE_HOST_AUTH_CHECK_FAILED";
  if (error) publicError.cause = error;
  return publicError;
}

function normalizeAuthMode(value, fallback = "key") {
  const normalized = normalizeText(value).toLowerCase();
  return AUTH_MODES.has(normalized) ? normalized : fallback;
}

function parseInteger(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePort(value, fallback = null) {
  const parsed = parseInteger(value, null);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function normalizeBool(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = normalizeText(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return fallback;
}

function sshTargetLabel(profile) {
  const user = profile.sshUser ? `${profile.sshUser}@` : "";
  const port = profile.sshPort && profile.sshPort !== DEFAULT_SSH_PORT ? `:${profile.sshPort}` : "";
  return `${user}${profile.sshHost}${port}`;
}

/**
 * Convert a remote-host row into its provisioning profile and derived availability state.
 * Secrets remain masked unless explicitly requested by a trusted internal caller.
 *
 * @param {Object} row - Remote-host database row.
 * @param {Object} [options={}] - Profile serialization options.
 * @returns {Object|null} Normalized remote-host profile.
 */
function rowToProfile(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const id = normalizeHostId(row.id || row.host_id || row.label || "host");
  const executionTargetId = `remote:${id}`;
  const authMode = normalizeAuthMode(row.ssh_auth_mode);
  const sshHost = normalizeText(row.ssh_host);
  const sshUser = normalizeText(row.ssh_user);
  const label = normalizeText(row.label) || sshHost || id;
  const hasPrivateKey = Boolean(row.ssh_private_key_encrypted);
  const hasPassword = Boolean(row.ssh_password_encrypted);
  const hasCredential = authMode === "password" ? hasPassword : hasPrivateKey;
  const configured = Boolean(sshHost) && Boolean(sshUser) && hasCredential;
  const hasHostKeyPin = Boolean(normalizeText(row.ssh_host_key));
  // A legacy `last_test_status=ok` row without the key captured by that test is
  // not a trusted connection. Treat it exactly like a host that needs a fresh
  // Test so ordinary lifecycle/runtime traffic never falls back to TOFU.
  const testedOk = row.last_test_status === "ok" && hasHostKeyPin;
  const issue = !configured
    ? !sshHost
      ? "Remote host requires an SSH host address."
      : !sshUser
        ? "Remote host requires an SSH username."
        : authMode === "password"
          ? "Remote host requires an SSH password."
          : "Remote host requires an SSH private key."
    : !testedOk
      ? row.last_test_status === "failed"
        ? row.last_test_message || "Remote host connection test failed."
        : row.last_test_status === "ok"
          ? "Remote host must pass Test again so Nora can pin its SSH host key."
          : "Remote host must pass the connection test before deployment."
      : null;

  let sshPrivateKey = null;
  let sshPassword = null;
  let sshPassphrase = null;
  if (includeSecret) {
    if (row.ssh_private_key_encrypted) sshPrivateKey = decrypt(row.ssh_private_key_encrypted);
    if (row.ssh_password_encrypted) sshPassword = decrypt(row.ssh_password_encrypted);
    if (row.ssh_passphrase_encrypted) sshPassphrase = decrypt(row.ssh_passphrase_encrypted);
  }

  return {
    id,
    executionTargetId,
    adapter: "remote-docker",
    deployTarget: "remote-docker",
    ownerUserId: row.owner_user_id || null,
    label,
    shortLabel: label,
    enabled: row.enabled !== false,
    isDefault: row.is_default === true,
    sshHost,
    sshPort: parsePort(row.ssh_port, DEFAULT_SSH_PORT),
    sshUser,
    sshAuthMode: authMode,
    sshPrivateKey,
    sshPassword,
    sshPassphrase,
    gatewayHost: normalizeText(row.gateway_host) || sshHost,
    dockerHost: normalizeText(row.docker_host),
    sshHostKey: normalizeText(row.ssh_host_key),
    configured,
    connected: testedOk,
    available: row.enabled !== false && configured && testedOk,
    issue,
    lastTestStatus: row.last_test_status || null,
    lastTestMessage: row.last_test_message || null,
    lastTestedAt: row.last_tested_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function maskHost(row) {
  const profile = rowToProfile(row, { includeSecret: false });
  return {
    ...profile,
    hasSshPrivateKey: Boolean(row?.ssh_private_key_encrypted),
    hasSshPassword: Boolean(row?.ssh_password_encrypted),
    hasSshPassphrase: Boolean(row?.ssh_passphrase_encrypted),
    sshPrivateKey: undefined,
    sshPassword: undefined,
    sshPassphrase: undefined,
  };
}

/**
 * Normalize create or update input, encrypting new SSH credentials and honoring explicit clears.
 *
 * @param {Object} [input={}] - Requested remote-host fields.
 * @param {Object|null} [existing=null] - Existing row whose omitted values should be preserved.
 * @returns {Object} Database-facing host fields with encrypted credential material.
 */
function normalizeHostInput(input = {}, existing = null) {
  const label = normalizeText(input.label ?? existing?.label);
  const id = existing
    ? normalizeHostId(existing.id)
    : normalizeHostId(input.id || input.hostId, label);
  const authMode = normalizeAuthMode(
    input.sshAuthMode ?? input.ssh_auth_mode,
    existing?.ssh_auth_mode || "key",
  );

  const privateKeyInput = normalizeText(input.sshPrivateKey ?? input.ssh_private_key);
  const passwordInput = normalizeText(input.sshPassword ?? input.ssh_password);
  const passphraseInput = normalizeText(input.sshPassphrase ?? input.ssh_passphrase);
  const clearPrivateKey = normalizeBool(input.clearSshPrivateKey ?? input.clear_ssh_private_key);
  const clearPassword = normalizeBool(input.clearSshPassword ?? input.clear_ssh_password);
  const clearPassphrase = normalizeBool(input.clearSshPassphrase ?? input.clear_ssh_passphrase);

  if (privateKeyInput || passwordInput || passphraseInput) {
    ensureEncryptionConfigured("Remote host SSH credential storage");
  }

  let privateKeyEncrypted = existing?.ssh_private_key_encrypted || null;
  if (clearPrivateKey) privateKeyEncrypted = null;
  if (privateKeyInput) privateKeyEncrypted = encrypt(privateKeyInput);

  let passwordEncrypted = existing?.ssh_password_encrypted || null;
  if (clearPassword) passwordEncrypted = null;
  if (passwordInput) passwordEncrypted = encrypt(passwordInput);

  let passphraseEncrypted = existing?.ssh_passphrase_encrypted || null;
  if (clearPassphrase) passphraseEncrypted = null;
  if (passphraseInput) passphraseEncrypted = encrypt(passphraseInput);

  const ownerUserId = input.ownerUserId ?? input.owner_user_id ?? existing?.owner_user_id ?? null;

  return {
    id,
    ownerUserId: ownerUserId || null,
    label: label || id,
    enabled: normalizeBool(input.enabled, existing?.enabled ?? true),
    isDefault: normalizeBool(input.isDefault ?? input.is_default, existing?.is_default ?? false),
    sshHost: normalizeRemoteAddress(
      input.sshHost ?? input.ssh_host ?? existing?.ssh_host,
      "Remote SSH host",
    ),
    sshPort: parsePort(input.sshPort ?? input.ssh_port, existing?.ssh_port ?? DEFAULT_SSH_PORT),
    sshUser: normalizeText(input.sshUser ?? input.ssh_user ?? existing?.ssh_user),
    sshAuthMode: authMode,
    sshPrivateKeyEncrypted: privateKeyEncrypted,
    sshPasswordEncrypted: passwordEncrypted,
    sshPassphraseEncrypted: passphraseEncrypted,
    gatewayHost: normalizeRemoteAddress(
      input.gatewayHost ?? input.gateway_host ?? existing?.gateway_host,
      "Remote gateway address",
    ),
    dockerHost: normalizeText(input.dockerHost ?? input.docker_host ?? existing?.docker_host),
  };
}

function connectionInputChanged(existing, host) {
  if (!existing) return false;
  return (
    normalizeText(existing.ssh_host) !== host.sshHost ||
    parsePort(existing.ssh_port, DEFAULT_SSH_PORT) !== host.sshPort ||
    normalizeText(existing.ssh_user) !== host.sshUser ||
    normalizeText(existing.ssh_auth_mode) !== host.sshAuthMode ||
    normalizeText(existing.ssh_private_key_encrypted) !==
      normalizeText(host.sshPrivateKeyEncrypted) ||
    normalizeText(existing.ssh_password_encrypted) !== normalizeText(host.sshPasswordEncrypted) ||
    normalizeText(existing.ssh_passphrase_encrypted) !==
      normalizeText(host.sshPassphraseEncrypted) ||
    normalizeText(existing.gateway_host) !== host.gatewayHost ||
    normalizeText(existing.docker_host) !== host.dockerHost
  );
}

function sshHostIdentityChanged(existing, host) {
  if (!existing) return false;
  return (
    normalizeText(existing.ssh_host) !== host.sshHost ||
    parsePort(existing.ssh_port, DEFAULT_SSH_PORT) !== host.sshPort
  );
}

// Registry persistence

/**
 * List remote hosts with optional owner scoping and secret inclusion.
 * A missing registry table is treated as an empty installation during migrations.
 *
 * @param {Object} [options={}] - Disabled-row, owner, and secret visibility options.
 * @returns {Promise<Array>} Normalized host profiles.
 */
async function listRemoteHosts(options = {}) {
  const includeDisabled = options.includeDisabled !== false;
  const includeSecret = options.includeSecret === true;
  const ownerUserId = options.ownerUserId || null;
  const conditions = [];
  const params = [];
  if (!includeDisabled) conditions.push("enabled = true");
  if (ownerUserId) {
    params.push(ownerUserId);
    conditions.push(`owner_user_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await db.query(
      `SELECT *
         FROM remote_hosts
        ${where}
        ORDER BY is_default DESC, label ASC, id ASC`,
      params,
    );
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    return rows.map((row) =>
      includeSecret ? rowToProfile(row, { includeSecret: true }) : maskHost(row),
    );
  } catch (error) {
    if (error?.code === "42P01") return []; // table not migrated yet
    throw error;
  }
}

async function listRemoteHostExecutionTargets(options = {}) {
  if (isPaaSMode()) return [];
  const hosts = await listRemoteHosts({ ...options, includeDisabled: false });
  return hosts.filter((host) => host.available);
}

async function getHostRow(hostId) {
  const id = normalizeHostId(hostId);
  const result = await db.query("SELECT * FROM remote_hosts WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function getOwnedHostRow(hostId, expectedOwnerUserId) {
  const id = normalizeHostId(hostId);
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  const result = await db.query("SELECT * FROM remote_hosts WHERE id = $1 AND owner_user_id = $2", [
    id,
    ownerUserId,
  ]);
  return result.rows[0] || null;
}

/**
 * Load a secret-bearing remote-host profile for trusted provisioning callers.
 * This lookup performs no user authorization or availability check and returns
 * null in hosted mode.
 *
 * @param {string} executionTargetId - Target in `remote:<id>` form.
 * @returns {Promise<Object|null>} Decrypted provisioning profile or `null`.
 */
async function getRemoteHostProfile(executionTargetId) {
  if (isPaaSMode()) return null;
  const normalized = normalizeRemoteExecutionTargetId(executionTargetId);
  if (!normalized) return null;
  const row = await getHostRow(normalized.slice("remote:".length));
  return resolveRemoteHostRuntimeProfile(rowToProfile(row, { includeSecret: true }));
}

function createRemoteHostCleanupTargetError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = "REMOTE_HOST_CLEANUP_TARGET_INVALID";
  return error;
}

// Stop/destroy need one deliberately narrower escape hatch than ordinary
// Remote Docker use. It reads only the host named by the persisted agent's
// explicit execution target, including in PaaS mode, where registration and
// every active-use lookup remain disabled. Callers must not derive this target
// from deploy_target/backend_type because those identify only the adapter, not
// the exact machine that owns the runtime being retired.
async function getRemoteHostCleanupProfile(agent = {}) {
  const rawExecutionTargetId = normalizeText(
    agent.execution_target_id ?? agent.executionTargetId,
  ).toLowerCase();
  const executionTargetId = normalizeRemoteExecutionTargetId(rawExecutionTargetId);
  if (!executionTargetId || rawExecutionTargetId !== executionTargetId) {
    throw createRemoteHostCleanupTargetError(
      "Remote Docker cleanup requires the agent's exact remote:<host-id> execution target",
    );
  }

  const row = await getHostRow(executionTargetId.slice("remote:".length));
  if (!row) return null;

  // Verify the returned registry identity before decrypting credentials. The
  // equality is redundant with a healthy primary-key lookup but keeps this
  // privileged cleanup path fail-closed under corrupt/misrouted data access.
  const rowExecutionTargetId = `remote:${normalizeHostId(row.id)}`;
  if (rowExecutionTargetId !== executionTargetId) {
    throw createRemoteHostCleanupTargetError(
      "Remote Docker cleanup host does not match the agent execution target",
    );
  }

  // Cleanup deliberately bypasses the current workspace grant and Test status,
  // but it must never bypass machine identity. A retained pin lets stop/delete
  // target the exact previously trusted host after revocation or a failed
  // retest. Without one (legacy row, explicit reset, or host-address change),
  // fail with an orphan-risk warning before decrypting credentials.
  if (!normalizeText(row.ssh_host_key)) {
    throw createRemoteHostCleanupPinRequiredError({
      id: row.id,
      label: normalizeText(row.label),
    });
  }

  const profile = rowToProfile(row, { includeSecret: true });
  // Existing agents may reference private-network hosts registered before a
  // control plane switched to PaaS mode. Cleanup uses that immutable stored
  // address only; PaaS still blocks create/update/test/list/use paths, so this
  // cannot register or activate a new private target.
  const rawSshHost = profile.sshHost;
  const rawGatewayHost = profile.gatewayHost || profile.sshHost;
  const [sshHost, gatewayHost] = await Promise.all([
    resolveRemoteAddressForRuntime(rawSshHost, "Remote SSH host", { publicOnly: false }),
    resolveRemoteAddressForRuntime(rawGatewayHost, "Remote gateway address", {
      publicOnly: false,
    }),
  ]);
  return { ...profile, rawSshHost, rawGatewayHost, sshHost, gatewayHost };
}

// Masked single-host lookup by id (no secrets) — used by the route layer to
// enforce per-owner access before mutating.
async function getRemoteHost(hostId) {
  const row = await getHostRow(hostId);
  return row ? maskHost(row) : null;
}

/**
 * Load a masked host by execution target for address allowlisting without decrypting credentials.
 *
 * @param {string} executionTargetId - Target in `remote:<id>` form.
 * @returns {Promise<Object|null>} Masked host profile or `null`.
 */
async function getRemoteHostByExecutionTarget(executionTargetId) {
  if (isPaaSMode()) return null;
  const normalized = normalizeRemoteExecutionTargetId(executionTargetId);
  if (!normalized) return null;
  const host = await getRemoteHost(normalized.slice("remote:".length));
  return resolveRemoteHostRuntimeProfile(host);
}

async function clearOtherDefaults(hostId, ownerUserId) {
  await db.query(
    `UPDATE remote_hosts
        SET is_default = false
      WHERE id <> $1
        AND owner_user_id IS NOT DISTINCT FROM $2`,
    [hostId, ownerUserId || null],
  );
}

async function createRemoteHostLocked(host) {
  const result = await db.query(
    `INSERT INTO remote_hosts(
       id, owner_user_id, label, enabled, is_default,
       ssh_host, ssh_port, ssh_user, ssh_auth_mode,
       ssh_private_key_encrypted, ssh_password_encrypted, ssh_passphrase_encrypted,
       gateway_host, docker_host
     ) VALUES(
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12,
       $13, $14
     )
     RETURNING *`,
    [
      host.id,
      host.ownerUserId,
      host.label,
      host.enabled,
      host.isDefault,
      host.sshHost,
      host.sshPort,
      host.sshUser,
      host.sshAuthMode,
      host.sshPrivateKeyEncrypted,
      host.sshPasswordEncrypted,
      host.sshPassphraseEncrypted,
      host.gatewayHost,
      host.dockerHost,
    ],
  );
  if (host.isDefault) await clearOtherDefaults(host.id, host.ownerUserId);
  return maskHost(result.rows[0]);
}

/**
 * Register an owner-scoped remote host under a per-host mutation lock, validating
 * its runtime addresses and encrypting supplied SSH credentials.
 *
 * @param {Object} [input={}] - Remote-host registration fields from a trusted caller.
 * @returns {Promise<Object>} Persisted masked host profile.
 */
async function createRemoteHost(input = {}) {
  assertRemoteHostsSupported();
  const host = normalizeHostInput(input);
  host.ownerUserId = requireRemoteHostOwnerUserId(host.ownerUserId);
  await resolveRemoteHostRuntimeProfile({
    sshHost: host.sshHost,
    gatewayHost: host.gatewayHost || host.sshHost,
  });
  return withRemoteHostMutationLock(host.id, () => createRemoteHostLocked(host));
}

async function updateRemoteHostLocked(hostId, input = {}, expectedOwnerUserId) {
  assertRemoteHostsSupported();
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  const existing = await getOwnedHostRow(hostId, ownerUserId);
  if (!existing) throw createRemoteHostNotFoundError();
  const host = normalizeHostInput(input, existing);
  // Ownership is immutable. The expected owner comes from the authenticated
  // route, not from a request body that could try to reassign the row.
  host.ownerUserId = ownerUserId;
  const resetTest = connectionInputChanged(existing, host);
  const resetHostKey = sshHostIdentityChanged(existing, host);
  await resolveRemoteHostRuntimeProfile({
    sshHost: host.sshHost,
    gatewayHost: host.gatewayHost || host.sshHost,
  });
  const result = await db.query(
    `UPDATE remote_hosts
        SET label = $2,
            owner_user_id = $3,
            enabled = $4,
            is_default = $5,
            ssh_host = $6,
            ssh_port = $7,
            ssh_user = $8,
            ssh_auth_mode = $9,
            ssh_private_key_encrypted = $10,
            ssh_password_encrypted = $11,
            ssh_passphrase_encrypted = $12,
            gateway_host = $13,
            docker_host = $14,
            last_test_status = CASE WHEN $15 THEN NULL ELSE last_test_status END,
            last_test_message = CASE WHEN $15 THEN NULL ELSE last_test_message END,
            last_tested_at = CASE WHEN $15 THEN NULL ELSE last_tested_at END,
            -- The host-key pin belongs to the SSH network identity, not to the
            -- credential. Rotating a password/key must retain the pin; only an
            -- explicit SSH host/port change returns to trust-on-first-use.
            ssh_host_key = CASE WHEN $16 THEN NULL ELSE ssh_host_key END,
            updated_at = NOW()
      WHERE id = $1
        AND owner_user_id = $17
      RETURNING *`,
    [
      existing.id,
      host.label,
      host.ownerUserId,
      host.enabled,
      host.isDefault,
      host.sshHost,
      host.sshPort,
      host.sshUser,
      host.sshAuthMode,
      host.sshPrivateKeyEncrypted,
      host.sshPasswordEncrypted,
      host.sshPassphraseEncrypted,
      host.gatewayHost,
      host.dockerHost,
      resetTest,
      resetHostKey,
      ownerUserId,
    ],
  );
  if (!result.rows[0]) throw createRemoteHostNotFoundError();
  if (host.isDefault) await clearOtherDefaults(existing.id, host.ownerUserId);
  return maskHost(result.rows[0]);
}

/**
 * Update an owner-scoped host under its mutation lock, invalidating the test
 * result for connection changes and the SSH pin only for host identity changes.
 *
 * @param {string} hostId - Remote host to update.
 * @param {Object} [input={}] - Replacement and credential-clear fields.
 * @param {Object} [options={}] - Required expected owner scope.
 * @returns {Promise<Object>} Updated masked host profile.
 */
async function updateRemoteHost(hostId, input = {}, options = {}) {
  assertRemoteHostsSupported();
  const expectedOwnerUserId = requireRemoteHostOwnerUserId(options.expectedOwnerUserId);
  return withRemoteHostMutationLock(hostId, () =>
    updateRemoteHostLocked(hostId, input, expectedOwnerUserId),
  );
}

function assertHostKeyPinResetConfirmation(existing, confirmation) {
  const provided = normalizeText(confirmation);
  const label = normalizeText(existing?.label);
  const id = normalizeHostId(existing?.id || existing?.host_id || label);
  if (provided && (provided === label || provided === id)) return;

  const error = new Error(`Type the remote host label "${label}" or id "${id}" to confirm`);
  error.statusCode = 400;
  error.code = "REMOTE_HOST_PIN_RESET_CONFIRMATION_INVALID";
  throw error;
}

// Explicit recovery for an intentionally rebuilt host at the same SSH address.
// This is deliberately separate from ordinary edits: credentials and network
// identity stay untouched, while clearing the pin also invalidates the previous
// Test result so active use remains fail-closed until a fresh successful probe
// observes and pins the replacement SSH key.
async function resetRemoteHostHostKeyPinLocked(hostId, confirmation, expectedOwnerUserId) {
  assertRemoteHostsSupported();
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  const existing = await getOwnedHostRow(hostId, ownerUserId);
  if (!existing) throw createRemoteHostNotFoundError();
  assertHostKeyPinResetConfirmation(existing, confirmation);

  const result = await db.query(
    `UPDATE remote_hosts
        SET ssh_host_key = NULL,
            last_test_status = NULL,
            last_test_message = NULL,
            last_tested_at = NULL,
            updated_at = NOW()
      WHERE id = $1
        AND owner_user_id = $2
      RETURNING *`,
    [existing.id, ownerUserId],
  );
  if (!result.rows[0]) throw createRemoteHostNotFoundError();
  return maskHost(result.rows[0]);
}

async function resetRemoteHostHostKeyPin(hostId, confirmation, options = {}) {
  assertRemoteHostsSupported();
  const expectedOwnerUserId = requireRemoteHostOwnerUserId(options.expectedOwnerUserId);
  return withRemoteHostMutationLock(hostId, () =>
    resetRemoteHostHostKeyPinLocked(hostId, confirmation, expectedOwnerUserId),
  );
}

async function deleteRemoteHostLocked(hostId, expectedOwnerUserId) {
  const id = normalizeHostId(hostId);
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  const existing = await getOwnedHostRow(id, ownerUserId);
  if (!existing) throw createRemoteHostNotFoundError();
  const executionTargetId = `remote:${id}`;
  const usage = await db.query(
    "SELECT COUNT(*)::int AS count FROM agents WHERE execution_target_id = $1 AND status <> 'deleted'",
    [executionTargetId],
  );
  if ((usage.rows[0]?.count || 0) > 0) {
    const error = new Error("Cannot delete a remote host while agents still reference it");
    error.statusCode = 409;
    throw error;
  }
  const result = await db.query(
    "DELETE FROM remote_hosts WHERE id = $1 AND owner_user_id = $2 RETURNING *",
    [id, ownerUserId],
  );
  if (!result.rows[0]) throw createRemoteHostNotFoundError();
  return maskHost(result.rows[0]);
}

/**
 * Delete an owner-scoped host under its mutation lock only when no non-deleted
 * agent still references its execution target.
 *
 * @param {string} hostId - Remote host to delete.
 * @param {Object} [options={}] - Required expected owner scope.
 * @returns {Promise<Object>} Deleted masked host profile.
 */
async function deleteRemoteHost(hostId, options = {}) {
  const expectedOwnerUserId = requireRemoteHostOwnerUserId(options.expectedOwnerUserId);
  return withRemoteHostMutationLock(hostId, () =>
    deleteRemoteHostLocked(hostId, expectedOwnerUserId),
  );
}

// SSH connectivity verification

function buildSshConnectConfig(profile, timeoutMs, { onHostKey } = {}) {
  const config = {
    host: profile.sshHost,
    port: profile.sshPort || DEFAULT_SSH_PORT,
    username: profile.sshUser,
    readyTimeout: timeoutMs,
  };
  if (profile.sshAuthMode === "password") {
    config.password = profile.sshPassword || "";
  } else {
    config.privateKey = profile.sshPrivateKey || "";
    if (profile.sshPassphrase) config.passphrase = profile.sshPassphrase;
  }
  // Host-key pinning: capture the presented key (base64) for the caller, and —
  // when a key is already pinned — reject a mismatch (MITM / changed host).
  const expected = normalizeText(profile.sshHostKey);
  config.hostVerifier = (key) => {
    const presented = Buffer.isBuffer(key) ? key.toString("base64") : String(key || "");
    if (typeof onHostKey === "function") {
      try {
        onHostKey(presented);
      } catch {
        /* capture is best-effort */
      }
    }
    if (expected) return presented === expected;
    return true; // trust-on-first-use: no pin yet
  };
  return config;
}

/**
 * Probe Docker over SSH while enforcing any pinned host key and capturing a first-use key.
 * Expected connection and command failures resolve as structured results for persistence.
 *
 * @param {Object} profile - Secret-bearing remote-host profile.
 * @param {Object} [options={}] - Probe timeout options.
 * @returns {Promise<Object>} Probe status, message, and optional presented host key.
 */
function runRemoteDockerProbe(profile, { timeoutMs = DEFAULT_TEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const Client = getSshClientCtor();
    const conn = new Client();
    let settled = false;
    // Capture the presented host key (base64) and detect a mismatch vs the pin.
    const expectedHostKey = normalizeText(profile.sshHostKey);
    let capturedHostKey = null;
    let hostKeyMismatch = false;
    const boundedTimeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_TEST_TIMEOUT_MS);
    let probeTimer = null;
    const onHostKey = (presented) => {
      capturedHostKey = presented;
      if (expectedHostKey && presented !== expectedHostKey) hostKeyMismatch = true;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (probeTimer) clearTimeout(probeTimer);
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    probeTimer = setTimeout(() => {
      finish({
        ok: false,
        message: `Remote Docker probe timed out after ${boundedTimeoutMs}ms.`,
      });
    }, boundedTimeoutMs);
    probeTimer.unref?.();

    conn.on("ready", () => {
      conn.exec(DOCKER_VERSION_PROBE, (err, stream) => {
        if (err) {
          finish({ ok: false, message: `Remote command failed: ${err.message}` });
          return;
        }
        let stdout = "";
        let stderr = "";
        stream
          .on("close", (code) => {
            const version = stdout.trim();
            if (code === 0 && version) {
              finish({
                ok: true,
                message: `Docker ${version} is reachable over SSH at ${sshTargetLabel(profile)}.`,
                hostKey: capturedHostKey,
              });
            } else {
              finish({
                ok: false,
                message:
                  stderr.trim() ||
                  `Docker is not available on ${profile.sshHost || "the remote host"} (exit ${code}).`,
              });
            }
          })
          .on("data", (chunk) => {
            stdout += chunk.toString();
          })
          .stderr.on("data", (chunk) => {
            stderr += chunk.toString();
          });
      });
    });

    conn.on("error", (err) => {
      if (hostKeyMismatch) {
        finish({
          ok: false,
          hostKeyMismatch: true,
          message:
            "Remote host key does not match the pinned key — connection refused (possible " +
            "man-in-the-middle, or the host was rebuilt). Use the explicit host-key pin reset only after independently verifying an expected rebuild or key rotation.",
        });
        return;
      }
      finish({ ok: false, message: err?.message || "SSH connection failed." });
    });

    try {
      conn.connect(buildSshConnectConfig(profile, boundedTimeoutMs, { onHostKey }));
    } catch (err) {
      finish({ ok: false, message: err?.message || "SSH connection could not be started." });
    }
  });
}

async function testRemoteHostLocked(hostId, options = {}) {
  assertRemoteHostsSupported();
  const ownerUserId = requireRemoteHostOwnerUserId(options.expectedOwnerUserId);
  const row = await getOwnedHostRow(hostId, ownerUserId);
  if (!row) throw createRemoteHostNotFoundError();
  const profile = await resolveRemoteHostRuntimeProfile(rowToProfile(row, { includeSecret: true }));
  let status = "ok";
  let message = "Docker is reachable over SSH.";
  let pinHostKey = null;
  if (!profile.configured) {
    status = "failed";
    message = profile.issue || "Remote host is not configured.";
  } else {
    const probe = await runRemoteDockerProbe(profile, options);
    const presentedHostKey = normalizeText(probe.hostKey);
    status = probe.ok && presentedHostKey ? "ok" : "failed";
    message =
      probe.ok && !presentedHostKey
        ? "SSH connected, but Nora could not verify and pin the presented host key; the host remains unavailable."
        : probe.message;
    // Trust-on-first-use: pin the host key on the first successful test. Once
    // pinned it's never overwritten here — a changed key fails the probe above
    // (hostKeyMismatch), so re-pinning requires the explicit reset flow.
    if (status === "ok" && !normalizeText(profile.sshHostKey)) {
      pinHostKey = presentedHostKey;
    }
  }
  const result = await db.query(
    `UPDATE remote_hosts
        SET last_test_status = $2,
            last_test_message = $3,
            ssh_host_key = COALESCE(ssh_host_key, $4),
            last_tested_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND owner_user_id = $5
      RETURNING *`,
    [profile.id, status, message, pinHostKey, ownerUserId],
  );
  if (!result.rows[0]) throw createRemoteHostNotFoundError();
  return maskHost(result.rows[0]);
}

/**
 * Test an owner-scoped host under its mutation lock, persist the result, and
 * pin its SSH host key on first success.
 *
 * @param {string} hostId - Remote host to test.
 * @param {Object} [options={}] - Required owner scope and SSH probe options.
 * @returns {Promise<Object>} Updated masked host profile with the stored result.
 */
async function testRemoteHost(hostId, options = {}) {
  assertRemoteHostsSupported();
  const expectedOwnerUserId = requireRemoteHostOwnerUserId(options.expectedOwnerUserId);
  return withRemoteHostMutationLock(hostId, () =>
    testRemoteHostLocked(hostId, { ...options, expectedOwnerUserId }),
  );
}

// Workspace grants and deployment eligibility

// Workspace roles (editor and above) that may USE a shared remote host — deploy
// agents to it and reach them through the gateway. Mirrors WORKSPACE_ROLE_RANK in
// middleware/ownership.ts (viewer:0, editor:1, admin:2, owner:3). Viewer can see a
// shared host (visibility) but not deploy to it. Host config stays owner-only.
const HOST_USE_ROLES = Object.freeze(["editor", "admin", "owner"]);

// Return the exact registry row authorized by the same PostgreSQL statement.
// This prevents an id from being deleted/recreated between checking a grant and
// loading/decrypting the profile for a different tenant's replacement row.
async function getAuthorizedRemoteHostRow(userId, hostId) {
  if (!userId || !hostId) return null;
  try {
    const result = await db.query(
      `SELECT rh.*
         FROM remote_hosts rh
        WHERE rh.id = $1
          AND (
            rh.owner_user_id = $2
            OR EXISTS (
              SELECT 1
                FROM workspace_remote_hosts wrh
                JOIN workspace_members wm ON wm.workspace_id = wrh.workspace_id
               WHERE wrh.remote_host_id = rh.id
                 AND wm.user_id = $2
                 AND wm.role = ANY($3)
            )
          )
        LIMIT 1`,
      [hostId, userId, HOST_USE_ROLES],
    );
    return result.rows[0] || null;
  } catch (error) {
    if (error?.code !== "42P01") throw error;
    // During a rolling migration, fail closed for shared access while keeping
    // direct owners operational from one owner-bound row lookup.
    const owned = await db.query(
      "SELECT * FROM remote_hosts WHERE id = $1 AND owner_user_id = $2",
      [hostId, userId],
    );
    return owned.rows[0] || null;
  }
}

/**
 * Check whether a user owns a host or has an editor-or-higher workspace grant to use it.
 * Missing grant tables fail closed for shared access.
 *
 * @param {string} userId - User requesting deployment or gateway reachability.
 * @param {string} hostId - Remote host being used.
 * @returns {Promise<boolean>} Whether an explicit qualifying grant exists.
 */
async function userCanUseRemoteHost(userId, hostId) {
  if (!userId || !hostId) return false;
  const owned = await db.query(
    "SELECT 1 FROM remote_hosts WHERE id = $1 AND owner_user_id = $2 LIMIT 1",
    [hostId, userId],
  );
  if (owned.rows[0]) return true;
  try {
    const shared = await db.query(
      `SELECT 1
         FROM workspace_remote_hosts wrh
         JOIN workspace_members wm ON wm.workspace_id = wrh.workspace_id
        WHERE wrh.remote_host_id = $1
          AND wm.user_id = $2
          AND wm.role = ANY($3)
        LIMIT 1`,
      [hostId, userId, HOST_USE_ROLES],
    );
    return Boolean(shared.rows[0]);
  } catch (error) {
    if (error?.code === "42P01") return false; // grants table not migrated yet
    throw error;
  }
}

// Active Remote Docker operations must re-check the CURRENT positive grant.
// Agent ownership is intentionally separate from host ownership: keeping an
// agent row after a workspace share is removed must not let Nora keep using the
// former host owner's decrypted SSH/Docker credentials as a confused deputy.
// Stop/destroy cleanup paths bypass this guard explicitly in containerManager;
// all normal runtime access, queued work, proxying, and backups call it.
async function assertRemoteHostAgentUse(agent = {}, options = {}) {
  if (!isRemoteDockerAgent(agent)) return null;
  try {
    if (isPaaSMode()) throw createRemoteHostAccessRevokedError();
    const executionTargetId = normalizeRemoteExecutionTargetId(
      agent.execution_target_id || agent.executionTargetId,
    );
    const userId = agent.user_id || agent.userId || agent.ownerUserId || null;
    if (!executionTargetId || !userId) {
      throw createRemoteHostAccessRevokedError();
    }

    const hostId = executionTargetId.slice("remote:".length);
    const row = await getAuthorizedRemoteHostRow(userId, hostId);
    if (!row) throw createRemoteHostAccessRevokedError();
    const host = await resolveRemoteHostRuntimeProfile(rowToProfile(row, { includeSecret: false }));
    if (!host.connected) throw createRemoteHostRetestRequiredError(host);

    if (options.includeProfile === false) return host;

    // Decrypt the SAME owner/grant-verified row; never reload by global id.
    return await resolveRemoteHostRuntimeProfile(rowToProfile(row, { includeSecret: true }));
  } catch (error) {
    throw toPublicRemoteHostAuthorizationError(error);
  }
}

function isRemoteHostAccessRevokedError(error) {
  return error?.code === "REMOTE_HOST_ACCESS_REVOKED";
}

/**
 * List masked hosts a user owns or can see through workspace sharing.
 * Shared entries include whether the user's highest workspace role permits deployment.
 *
 * @param {string} userId - User whose accessible hosts should be listed.
 * @returns {Promise<Array>} Owned and shared profiles annotated with access rights.
 */
async function listAccessibleRemoteHosts(userId) {
  if (isPaaSMode()) return [];
  const owned = (await listRemoteHosts({ ownerUserId: userId, includeDisabled: true })).map(
    (host) => ({
      ...host,
      access: "owned",
      canDeploy: true,
    }),
  );
  const ownedIds = new Set(owned.map((host) => host.id));
  const shared = [];
  try {
    const rows = await db.query(
      `SELECT wrh.remote_host_id AS host_id,
              MAX(CASE wm.role
                    WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 WHEN 'editor' THEN 1 ELSE 0
                  END) AS rank
         FROM workspace_remote_hosts wrh
         JOIN workspace_members wm ON wm.workspace_id = wrh.workspace_id
        WHERE wm.user_id = $1
        GROUP BY wrh.remote_host_id`,
      [userId],
    );
    for (const row of rows.rows) {
      if (ownedIds.has(row.host_id)) continue;
      const host = await getRemoteHost(row.host_id);
      if (!host) continue;
      shared.push({ ...host, access: "shared", canDeploy: Number(row.rank) >= 1 });
    }
  } catch (error) {
    if (error?.code !== "42P01") throw error; // grants table not migrated yet
  }
  return [...owned, ...shared];
}

// Share a host into a workspace (idempotent). Both host ownership and current
// workspace membership are rechecked inside the per-host lock by the same SQL
// statement that creates the grant.
async function shareRemoteHostLocked(hostId, workspaceId, expectedOwnerUserId) {
  const id = normalizeHostId(hostId);
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  const existing = await getOwnedHostRow(id, ownerUserId);
  if (!existing) throw createRemoteHostNotFoundError();
  const result = await db.query(
    `WITH authorized AS (
       SELECT rh.id AS remote_host_id,
              wm.workspace_id,
              w.name AS workspace_name
         FROM remote_hosts rh
         JOIN workspace_members wm
           ON wm.workspace_id = $1
          AND wm.user_id = $3
         JOIN workspaces w ON w.id = wm.workspace_id
        WHERE rh.id = $2
          AND rh.owner_user_id = $3
     ), inserted AS (
       INSERT INTO workspace_remote_hosts (workspace_id, remote_host_id, created_by)
       SELECT workspace_id, remote_host_id, $3
         FROM authorized
        WHERE TRUE
       ON CONFLICT (workspace_id, remote_host_id) DO NOTHING
       RETURNING workspace_id
     )
     SELECT authorized.workspace_id AS "workspaceId",
            authorized.workspace_name AS "workspaceName",
            EXISTS (SELECT 1 FROM inserted) AS "inserted"
       FROM authorized`,
    [workspaceId, id, ownerUserId],
  );
  if (!result.rows[0]) {
    const error = new Error("Workspace not found");
    error.statusCode = 404;
    throw error;
  }
  return result.rows[0];
}

/**
 * Idempotently share an owner-scoped host after atomically rechecking current
 * host ownership and workspace membership under the per-host lock.
 *
 * @param {string} hostId - Remote host to share.
 * @param {string} workspaceId - Workspace receiving visibility and role-based use.
 * @param {string} expectedOwnerUserId - Expected host owner and current workspace member.
 * @returns {Promise<Object>} Workspace metadata and whether a new grant was inserted.
 */
async function shareRemoteHost(hostId, workspaceId, expectedOwnerUserId) {
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  return withRemoteHostMutationLock(hostId, () =>
    shareRemoteHostLocked(hostId, workspaceId, ownerUserId),
  );
}

async function unshareRemoteHostLocked(hostId, workspaceId, expectedOwnerUserId) {
  const id = normalizeHostId(hostId);
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  const existing = await getOwnedHostRow(id, ownerUserId);
  if (!existing) throw createRemoteHostNotFoundError();
  await db.query(
    `DELETE FROM workspace_remote_hosts wrh
      USING remote_hosts rh
      WHERE wrh.remote_host_id = $1
        AND wrh.workspace_id = $2
        AND rh.id = wrh.remote_host_id
        AND rh.owner_user_id = $3`,
    [id, workspaceId, ownerUserId],
  );
}

async function unshareRemoteHost(hostId, workspaceId, expectedOwnerUserId) {
  const ownerUserId = requireRemoteHostOwnerUserId(expectedOwnerUserId);
  return withRemoteHostMutationLock(hostId, () =>
    unshareRemoteHostLocked(hostId, workspaceId, ownerUserId),
  );
}

async function listRemoteHostShares(hostId, options = {}) {
  const id = normalizeHostId(hostId);
  const ownerUserId = requireRemoteHostOwnerUserId(options.expectedOwnerUserId);
  try {
    const rows = await db.query(
      `SELECT wrh.workspace_id AS "workspaceId", w.name AS "workspaceName", wrh.created_at AS "createdAt"
         FROM workspace_remote_hosts wrh
         JOIN workspaces w ON w.id = wrh.workspace_id
         JOIN remote_hosts rh ON rh.id = wrh.remote_host_id
        WHERE wrh.remote_host_id = $1
          AND rh.owner_user_id = $2
        ORDER BY w.name`,
      [id, ownerUserId],
    );
    return rows.rows;
  } catch (error) {
    if (error?.code === "42P01") return [];
    throw error;
  }
}

/**
 * Validate a remote-docker target before deployment and return its secret-bearing profile.
 * When an owner id is supplied, unowned and ungranted hosts are reported as unknown.
 *
 * @param {Object} [runtimeFields={}] - Runtime selection containing the remote execution target.
 * @param {Object} [options={}] - Optional owner scope for cross-tenant authorization.
 * @returns {Promise<Object|null>} Available provisioning profile, or `null` for other targets.
 */
async function assertRemoteHostExecutionTargetAvailable(runtimeFields = {}, options = {}) {
  if (!isRemoteDockerTarget(runtimeFields.deploy_target ?? runtimeFields.deployTarget)) {
    return null;
  }
  assertRemoteHostsSupported();
  const executionTargetId = normalizeRemoteExecutionTargetId(
    runtimeFields.execution_target_id || runtimeFields.executionTargetId,
  );
  if (!executionTargetId) {
    const error = new Error(
      "Remote-docker deployments require a registered host target such as remote:my-laptop.",
    );
    error.statusCode = 400;
    throw error;
  }
  const hostId = executionTargetId.slice("remote:".length);
  const ownerUserId = options.ownerUserId || null;
  // When a user owns the deployment, authorize and return the host row in one
  // statement. The admin path has no tenant owner and uses the direct row.
  const row = ownerUserId
    ? await getAuthorizedRemoteHostRow(ownerUserId, hostId)
    : await getHostRow(hostId);
  const host = row ? rowToProfile(row, { includeSecret: false }) : null;
  if (!host) {
    const error = new Error(`Unknown remote host execution target: ${executionTargetId}`);
    error.statusCode = 400;
    throw error;
  }
  if (!host.enabled) {
    const error = new Error(`${host.label} is disabled for new deployments.`);
    error.statusCode = 400;
    throw error;
  }
  if (!host.configured) {
    const error = new Error(host.issue || `${host.label} is not configured.`);
    error.statusCode = 400;
    throw error;
  }
  if (!host.connected) {
    const error = new Error(
      host.issue || `${host.label} must pass the connection test before deployment.`,
    );
    error.statusCode = 400;
    throw error;
  }
  return await resolveRemoteHostRuntimeProfile(rowToProfile(row, { includeSecret: true }));
}

module.exports = {
  assertRemoteHostAgentUse,
  assertRemoteHostExecutionTargetAvailable,
  assertRemoteHostsSupported,
  createRemoteHost,
  deleteRemoteHost,
  getRemoteHost,
  getRemoteHostByExecutionTarget,
  getRemoteHostCleanupProfile,
  getRemoteHostProfile,
  isRemoteDockerTarget,
  isRemoteDockerAgent,
  isRemoteHostAccessRevokedError,
  listRemoteHosts,
  listAccessibleRemoteHosts,
  listRemoteHostExecutionTargets,
  normalizeRemoteExecutionTargetId,
  resolveRemoteAddressForRuntime,
  resolveRemoteHostRuntimeProfile,
  resetRemoteHostHostKeyPin,
  rowToProfile,
  testRemoteHost,
  toPublicRemoteHostAuthorizationError,
  updateRemoteHost,
  userCanUseRemoteHost,
  shareRemoteHost,
  unshareRemoteHost,
  listRemoteHostShares,
};
