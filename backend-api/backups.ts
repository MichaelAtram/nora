// @ts-nocheck
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { promisify } = require("util");
const { gzip, createGzip } = require("zlib");

const tar = require("tar-stream");
const { Client: SshClient } = require("ssh2");

const db = require("./db");
const billing = require("./billing");
const { addBackupJob, addDeploymentJob } = require("./redisQueue");
const { getBackupSettings, getBackupStorageConfig } = require("./platformSettings");
const {
  buildMigrationManifestFromAgent,
  createMigrationDraft,
  materializeManagedMigrationState,
  packMigrationBundle,
  parseUploadedMigrationBuffer,
} = require("./agentMigrations");
const {
  createEmptyTemplatePayload,
  materializeTemplateWiring,
  resolveContainerName,
  serializeAgent,
} = require("./agentPayloads");
const { getDefaultAgentImage } = require("../agent-runtime/lib/agentImages");
const { getRuntimeSelectionStatus } = require("../agent-runtime/lib/backendCatalog");
const { assertKubernetesExecutionTargetAvailable } = require("./kubernetesClusters");
const { assertRemoteHostExecutionTargetAvailable } = require("./remoteHosts");
const { buildAgentRuntimeFields, resolveRequestedRuntimeFields } = require("./agentRuntimeFields");

const gzipAsync = promisify(gzip);

const BACKUP_ENCRYPTION_MAGIC = "NORA-BACKUP-ENC-v1";
const BACKUP_ARCHIVE_FORMAT = "nora-backup-archive/v1";
const READY_STATUSES = new Set(["ready", "ready_with_warnings"]);
const BACKUP_SCHEDULE_FREQUENCIES = new Set(["hourly", "daily", "weekly"]);
const BACKUP_KINDS = new Set(["agent", "installation"]);

function createHttpError(message, statusCode = 400, code = null, options = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  error.expose = options.expose ?? statusCode < 500;
  return error;
}

function normalizeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return typeof value === "object" ? value : fallback;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  }
  return fallback;
}

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeFrequency(value, fallback = "daily") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return BACKUP_SCHEDULE_FREQUENCIES.has(normalized) ? normalized : fallback;
}

function computeNextRunAt(schedule = {}, from = new Date()) {
  const frequency = normalizeFrequency(schedule.frequency, "daily");
  const hour = clampInteger(parseInteger(schedule.hour_utc ?? schedule.hourUtc, 2), 0, 23);
  const dayOfWeek = clampInteger(parseInteger(schedule.day_of_week ?? schedule.dayOfWeek, 0), 0, 6);
  const base = new Date(from);

  if (frequency === "hourly") {
    const next = new Date(
      Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate(),
        base.getUTCHours() + 1,
        0,
        0,
        0,
      ),
    );
    return next;
  }

  const candidate = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, 0, 0, 0),
  );

  if (frequency === "daily") {
    if (candidate <= base) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return candidate;
  }

  const daysUntilTarget = (dayOfWeek - candidate.getUTCDay() + 7) % 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysUntilTarget);
  if (candidate <= base) candidate.setUTCDate(candidate.getUTCDate() + 7);
  return candidate;
}

function serializeSchedule(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    enabled: row.enabled === true,
    name: row.name || null,
    user_id: row.user_id || null,
    agent_id: row.agent_id || null,
    frequency: row.frequency || "daily",
    hour_utc: Number(row.hour_utc ?? 2),
    day_of_week: Number(row.day_of_week ?? 0),
    next_run_at: row.next_run_at || null,
    last_run_at: row.last_run_at || null,
    last_backup_id: row.last_backup_id || null,
    last_error: row.last_error || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function serializeBackup(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    name: row.name,
    agent_id: row.agent_id,
    user_id: row.user_id,
    storage_backend: row.storage_backend || null,
    size_bytes: Number(row.size_bytes || 0),
    checksum_sha256: row.checksum_sha256 || null,
    content_type: row.content_type || "application/gzip",
    format: row.format || BACKUP_ARCHIVE_FORMAT,
    scope: normalizeJson(row.scope, {}),
    summary: normalizeJson(row.summary, {}),
    warnings: normalizeJson(row.warnings, []),
    error: row.error || null,
    expires_at: row.expires_at || null,
    completed_at: row.completed_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function requireBackupEncryptionKey() {
  const rawKey = String(process.env.NORA_BACKUP_ENCRYPTION_KEY || "")
    .split("#")[0]
    .trim();
  if (!/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    throw createHttpError(
      "Managed backup storage requires NORA_BACKUP_ENCRYPTION_KEY to be configured with a valid 64-char hex key",
      503,
      "BACKUP_ENCRYPTION_NOT_CONFIGURED",
      { expose: true },
    );
  }
  return Buffer.from(rawKey, "hex");
}

function encryptBackupBuffer(buffer) {
  const key = requireBackupEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.from(
    `${BACKUP_ENCRYPTION_MAGIC}\n${iv.toString("hex")}:${tag.toString("hex")}\n`,
    "utf8",
  );
  return Buffer.concat([header, encrypted]);
}

function decryptBackupBuffer(buffer) {
  const text = buffer.toString("utf8", 0, Math.min(buffer.length, 256));
  if (!text.startsWith(`${BACKUP_ENCRYPTION_MAGIC}\n`)) {
    throw createHttpError("Backup archive is not encrypted with the expected Nora format", 500);
  }
  const firstNewline = buffer.indexOf(0x0a);
  const secondNewline = buffer.indexOf(0x0a, firstNewline + 1);
  const meta = buffer.toString("utf8", firstNewline + 1, secondNewline);
  const [ivHex, tagHex] = meta.split(":");
  const key = requireBackupEncryptionKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(buffer.slice(secondNewline + 1)), decipher.final()]);
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertLocalStoragePath(storageKey, config = {}) {
  const root = path.resolve(config.localPath || "/var/lib/nora-backups");
  const resolved = path.resolve(root, storageKey);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw createHttpError("Invalid backup storage key", 500);
  }
  return resolved;
}

function throwIfAborted(signal, where = "operation") {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new Error(`${where} aborted`);
    if (!reason.statusCode) reason.statusCode = 499;
    throw reason;
  }
}

async function putLocalObject(storageKey, buffer, config = {}, { signal } = {}) {
  throwIfAborted(signal, "backup write");
  const target = assertLocalStoragePath(storageKey, config);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer, { mode: 0o600, signal });
}

async function getLocalObject(storageKey, config = {}, { signal } = {}) {
  throwIfAborted(signal, "backup read");
  return fs.readFile(assertLocalStoragePath(storageKey, config), { signal });
}

async function deleteLocalObject(storageKey, config = {}, { signal } = {}) {
  throwIfAborted(signal, "backup delete");
  try {
    await fs.unlink(assertLocalStoragePath(storageKey, config));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function hmac(key, value, encoding = null) {
  const digest = crypto.createHmac("sha256", key).update(value, "utf8");
  return encoding ? digest.digest(encoding) : digest.digest();
}

function hashHex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function s3Config(config = {}) {
  const bucket = config.s3Bucket;
  const region =
    config.storageBackend === "r2" && (!config.s3Region || config.s3Region === "us-east-1")
      ? "auto"
      : config.s3Region || "us-east-1";
  const accessKeyId = config.s3AccessKeyId;
  const secretAccessKey = config.s3SecretAccessKey;
  const sessionToken = config.s3SessionToken;
  const endpoint = String(config.s3Endpoint || "").replace(/\/+$/, "");
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw createHttpError(
      "S3 backup storage is not fully configured",
      503,
      "BACKUP_S3_NOT_CONFIGURED",
      {
        expose: true,
      },
    );
  }
  return { bucket, region, accessKeyId, secretAccessKey, sessionToken, endpoint };
}

function encodeS3Key(key) {
  return String(key)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function s3Request(method, storageKey, body = null, rawConfig = {}, { signal } = {}) {
  throwIfAborted(signal, "S3 request");
  const config = s3Config(rawConfig);
  const payload = body || Buffer.alloc(0);
  const encodedKey = encodeS3Key(storageKey);
  const pathStyle = Boolean(config.endpoint);
  const baseUrl = config.endpoint || `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
  const parsedBase = new URL(baseUrl);
  const canonicalUri = pathStyle ? `/${config.bucket}/${encodedKey}` : `/${encodedKey}`;
  const url = new URL(canonicalUri, baseUrl);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);
  const headers = {
    host: parsedBase.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (config.sessionToken) headers["x-amz-security-token"] = config.sessionToken;
  if (method === "PUT") headers["content-type"] = "application/octet-stream";

  const sortedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim()}\n`)
    .join("");
  const signedHeaders = sortedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hashHex(canonicalRequest)].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), "s3"),
    "aws4_request",
  );
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method,
    headers,
    signal,
    ...(method === "PUT" ? { body: payload } : {}),
  });
  if (!response.ok && !(method === "DELETE" && response.status === 404)) {
    const message = await response.text().catch(() => "");
    throw createHttpError(
      message || `S3 backup storage request failed with ${response.status}`,
      502,
    );
  }
  if (method === "GET") return Buffer.from(await response.arrayBuffer());
  return null;
}

function sshRemoteObjectPath(config = {}, storageKey = "") {
  const base = path.posix.normalize(
    String(config.sshRemotePath || "/backups/nora").replace(/\/+$/, ""),
  );
  const normalizedKey = String(storageKey).replace(/^\/+/, "");
  const resolved = path.posix.normalize(path.posix.join(base, normalizedKey));
  if (base !== "/" && !resolved.startsWith(`${base}/`)) {
    throw createHttpError("Invalid backup storage key", 500);
  }
  return resolved;
}

function connectSsh(config = {}, { signal } = {}) {
  if (!config.sshHost || !config.sshUsername) {
    throw createHttpError(
      "SSH backup storage requires a host and username",
      503,
      "BACKUP_SSH_NOT_CONFIGURED",
      {
        expose: true,
      },
    );
  }
  if (!config.sshPrivateKey && !config.sshPassword) {
    throw createHttpError(
      "SSH backup storage requires a private key or password",
      503,
      "BACKUP_SSH_NOT_CONFIGURED",
      { expose: true },
    );
  }
  throwIfAborted(signal, "SSH connect");

  return new Promise((resolve, reject) => {
    const client = new SshClient();
    let onAbort;
    if (signal) {
      onAbort = () => {
        try {
          client.end();
        } catch {
          /* best effort */
        }
        const reason = signal.reason instanceof Error ? signal.reason : new Error("SSH aborted");
        if (!reason.statusCode) reason.statusCode = 499;
        reject(reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const settle = (fn) => (arg) => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      fn(arg);
    };
    client
      .once("ready", () => settle(resolve)(client))
      .once("error", settle(reject))
      .connect({
        host: config.sshHost,
        port: config.sshPort || 22,
        username: config.sshUsername,
        ...(config.sshPrivateKey ? { privateKey: config.sshPrivateKey } : {}),
        ...(config.sshPassword ? { password: config.sshPassword } : {}),
        readyTimeout: 30000,
      });
  });
}

function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) return reject(error);
      resolve(sftp);
    });
  });
}

function sftpMkdir(sftp, directory) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(directory, { mode: 0o700 }, (error) => {
      if (error && error.code !== 4) return reject(error);
      resolve();
    });
  });
}

async function ensureSftpDirectory(sftp, directory) {
  const normalized = path.posix.normalize(directory);
  const parts = normalized.split("/").filter(Boolean);
  let current = normalized.startsWith("/") ? "/" : "";
  for (const part of parts) {
    current = current === "/" ? `/${part}` : current ? `${current}/${part}` : part;
    await sftpMkdir(sftp, current).catch(() => {});
  }
}

function sftpWriteFile(sftp, remotePath, buffer) {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, buffer, { mode: 0o600 }, (error) => {
      if (error) return reject(error);
      resolve();
    });
  });
}

function sftpReadFile(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readFile(remotePath, (error, data) => {
      if (error) return reject(error);
      resolve(Buffer.from(data));
    });
  });
}

function sftpUnlink(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (error) => {
      if (error && error.code !== 2) return reject(error);
      resolve();
    });
  });
}

async function withSftp(config, callback, { signal } = {}) {
  const client = await connectSsh(config, { signal });
  let onAbort;
  if (signal) {
    onAbort = () => {
      try {
        client.end();
      } catch {
        /* best effort */
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const sftp = await openSftp(client);
    return await callback(sftp);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    client.end();
  }
}

async function putSshObject(storageKey, buffer, config = {}, { signal } = {}) {
  const remotePath = sshRemoteObjectPath(config, storageKey);
  await withSftp(
    config,
    async (sftp) => {
      await ensureSftpDirectory(sftp, path.posix.dirname(remotePath));
      await sftpWriteFile(sftp, remotePath, buffer);
    },
    { signal },
  );
}

async function getSshObject(storageKey, config = {}, { signal } = {}) {
  const remotePath = sshRemoteObjectPath(config, storageKey);
  return withSftp(config, (sftp) => sftpReadFile(sftp, remotePath), { signal });
}

async function deleteSshObject(storageKey, config = {}, { signal } = {}) {
  const remotePath = sshRemoteObjectPath(config, storageKey);
  return withSftp(config, (sftp) => sftpUnlink(sftp, remotePath), { signal });
}

async function backupStorageConfig() {
  return getBackupStorageConfig();
}

function backupStorageConfigSnapshot(config = {}) {
  return {
    storageBackend: config.storageBackend || "local",
    localPath: config.localPath || "",
    s3Bucket: config.s3Bucket || "",
    s3Region: config.s3Region || "",
    s3Endpoint: config.s3Endpoint || "",
    sshHost: config.sshHost || "",
    sshPort: config.sshPort || 22,
    sshUsername: config.sshUsername || "",
    sshRemotePath: config.sshRemotePath || "",
  };
}

async function backupStorageConfigForBackup(backup = {}) {
  const config = await backupStorageConfig();
  const snapshot = normalizeJson(backup.storage_config, {});
  return {
    ...config,
    ...snapshot,
    storageBackend: backup.storage_backend || snapshot.storageBackend || config.storageBackend,
    s3AccessKeyId: config.s3AccessKeyId,
    s3SecretAccessKey: config.s3SecretAccessKey,
    s3SessionToken: config.s3SessionToken,
    sshPrivateKey: config.sshPrivateKey,
    sshPassword: config.sshPassword,
  };
}

async function putStorageObject(storageKey, buffer, config = null, { signal } = {}) {
  const resolved = config || (await backupStorageConfig());
  if (resolved.storageBackend === "s3" || resolved.storageBackend === "r2") {
    return s3Request("PUT", storageKey, buffer, resolved, { signal });
  }
  if (resolved.storageBackend === "ssh")
    return putSshObject(storageKey, buffer, resolved, { signal });
  return putLocalObject(storageKey, buffer, resolved, { signal });
}

async function getStorageObject(storageKey, config = null, { signal } = {}) {
  const resolved = config || (await backupStorageConfig());
  if (resolved.storageBackend === "s3" || resolved.storageBackend === "r2") {
    return s3Request("GET", storageKey, null, resolved, { signal });
  }
  if (resolved.storageBackend === "ssh") return getSshObject(storageKey, resolved, { signal });
  return getLocalObject(storageKey, resolved, { signal });
}

async function deleteStorageObject(storageKey, config = null, { signal } = {}) {
  if (!storageKey) return;
  const resolved = config || (await backupStorageConfig());
  if (resolved.storageBackend === "s3" || resolved.storageBackend === "r2") {
    return s3Request("DELETE", storageKey, null, resolved, { signal });
  }
  if (resolved.storageBackend === "ssh") return deleteSshObject(storageKey, resolved, { signal });
  return deleteLocalObject(storageKey, resolved, { signal });
}

async function loadOwnedAgent(agentId, userId) {
  const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
    agentId,
    userId,
  ]);
  return result.rows[0] || null;
}

async function loadBackup(
  backupId,
  { userId = null, agentId = null, includeDeleted = false } = {},
) {
  const params = [backupId];
  let userClause = "";
  if (userId) {
    params.push(userId);
    userClause = `AND user_id = $${params.length}`;
  }
  let agentClause = "";
  if (agentId) {
    params.push(agentId);
    agentClause = `AND agent_id = $${params.length}`;
  }
  const deletedClause = includeDeleted ? "" : "AND status <> 'deleted'";
  const result = await db.query(
    `SELECT *
       FROM backups
      WHERE id = $1
        ${userClause}
        ${agentClause}
        ${deletedClause}
      LIMIT 1`,
    params,
  );
  return result.rows[0] || null;
}

function expiresAtForSubscription(subscription = {}) {
  const days = Number.parseInt(subscription.backup_retention_days, 10);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(Date.now() + days * 86400000);
}

async function createAgentBackup({ userId, agentId, actorId = userId, name = "" } = {}) {
  const agent = await loadOwnedAgent(agentId, userId);
  if (!agent) throw createHttpError("Agent not found", 404);

  const limits = await billing.enforceBackupLimits(userId, { agentId });
  if (!limits.allowed) {
    const error = createHttpError(limits.error, 402);
    error.subscription = limits.subscription;
    throw error;
  }

  requireBackupEncryptionKey();
  const storageConfig = await backupStorageConfig();
  const runtimeFields = buildAgentRuntimeFields(agent);
  const requestedName = String(name || "").trim();
  const backupName = requestedName || `${agent.name || "Agent"} backup`;
  const result = await db.query(
    `INSERT INTO backups(
       user_id,
       agent_id,
       kind,
       status,
       name,
       storage_backend,
       content_type,
       format,
       scope,
       summary,
       warnings,
       created_by,
       expires_at
     )
     VALUES($1, $2, 'agent', 'queued', $3, $4, 'application/gzip', $5, $6, '{}', '[]', $7, $8)
     RETURNING *`,
    [
      userId,
      agent.id,
      backupName.slice(0, 160),
      storageConfig.storageBackend,
      BACKUP_ARCHIVE_FORMAT,
      JSON.stringify({
        agent: {
          id: agent.id,
          name: agent.name,
          runtimeFamily: runtimeFields.runtime_family,
          deployTarget: runtimeFields.deploy_target,
          executionTargetId: runtimeFields.execution_target_id,
          sandboxProfile: runtimeFields.sandbox_profile,
        },
      }),
      actorId,
      expiresAtForSubscription(limits.subscription),
    ],
  );
  return serializeBackup(result.rows[0]);
}

async function createInstallationBackup({ actorId, name = "" } = {}) {
  requireBackupEncryptionKey();
  const storageConfig = await backupStorageConfig();
  const backupName = String(name || "").trim() || "Installation backup";
  const result = await db.query(
    `INSERT INTO backups(
       user_id,
       kind,
       status,
       name,
       storage_backend,
       content_type,
       format,
       scope,
       summary,
       warnings,
       created_by
     )
     VALUES($1, 'installation', 'queued', $2, $3, 'application/gzip', $4, $5, '{}', '[]', $1)
     RETURNING *`,
    [
      actorId,
      backupName.slice(0, 160),
      storageConfig.storageBackend,
      BACKUP_ARCHIVE_FORMAT,
      JSON.stringify({ installation: true }),
    ],
  );
  return serializeBackup(result.rows[0]);
}

async function listAgentBackups(userId, agentId) {
  const agent = await loadOwnedAgent(agentId, userId);
  if (!agent) throw createHttpError("Agent not found", 404);
  const [rows, subscription, usage] = await Promise.all([
    db.query(
      `SELECT *
         FROM backups
        WHERE user_id = $1
          AND agent_id = $2
          AND kind = 'agent'
          AND status <> 'deleted'
        ORDER BY created_at DESC`,
      [userId, agentId],
    ),
    billing.getSubscription(userId),
    billing.getBackupUsage(userId, { agentId }),
  ]);
  return {
    backups: rows.rows.map(serializeBackup),
    entitlement: subscription,
    usage,
  };
}

async function listAdminBackups() {
  const result = await db.query(
    `SELECT b.*, u.email AS owner_email, a.name AS agent_name
       FROM backups b
       LEFT JOIN users u ON u.id = b.user_id
       LEFT JOIN agents a ON a.id = b.agent_id
      WHERE b.status <> 'deleted'
      ORDER BY b.created_at DESC
      LIMIT 200`,
  );
  return result.rows.map((row) => ({
    ...serializeBackup(row),
    owner_email: row.owner_email || null,
    agent_name: row.agent_name || null,
  }));
}

async function getAgentBackupSchedule(userId, agentId) {
  const agent = await loadOwnedAgent(agentId, userId);
  if (!agent) throw createHttpError("Agent not found", 404);
  const [scheduleResult, subscription] = await Promise.all([
    db.query(
      `SELECT *
         FROM backup_schedules
        WHERE kind = 'agent'
          AND user_id = $1
          AND agent_id = $2
        LIMIT 1`,
      [userId, agentId],
    ),
    billing.getSubscription(userId),
  ]);
  return {
    schedule: serializeSchedule(scheduleResult.rows[0]) || {
      kind: "agent",
      enabled: false,
      frequency: "daily",
      hour_utc: 2,
      day_of_week: 0,
      user_id: userId,
      agent_id: agentId,
    },
    entitlement: subscription,
  };
}

async function updateAgentBackupSchedule(userId, agentId, input = {}) {
  const agent = await loadOwnedAgent(agentId, userId);
  if (!agent) throw createHttpError("Agent not found", 404);

  const subscription = await billing.getSubscription(userId);
  const enabled = parseBoolean(input.enabled, false);
  if (enabled && !subscription.managed_backups_enabled) {
    throw createHttpError("Scheduled managed backups are not available on your current plan.", 402);
  }

  const frequency = normalizeFrequency(input.frequency, "daily");
  const hourUtc = clampInteger(parseInteger(input.hour_utc ?? input.hourUtc, 2), 0, 23);
  const dayOfWeek = clampInteger(parseInteger(input.day_of_week ?? input.dayOfWeek, 0), 0, 6);
  const nextRunAt = enabled
    ? computeNextRunAt({ frequency, hour_utc: hourUtc, day_of_week: dayOfWeek })
    : null;

  const result = await db.query(
    `INSERT INTO backup_schedules(
       schedule_key,
       kind,
       user_id,
       agent_id,
       enabled,
       name,
       frequency,
       hour_utc,
       day_of_week,
       next_run_at,
       created_by,
       updated_at
     )
     VALUES($1, 'agent', $2, $3, $4, $5, $6, $7, $8, $9, $2, NOW())
     ON CONFLICT (schedule_key) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       name = EXCLUDED.name,
       frequency = EXCLUDED.frequency,
       hour_utc = EXCLUDED.hour_utc,
       day_of_week = EXCLUDED.day_of_week,
       next_run_at = EXCLUDED.next_run_at,
       last_error = NULL,
       updated_at = NOW()
     RETURNING *`,
    [
      `agent:${agentId}`,
      userId,
      agentId,
      enabled,
      String(input.name || `${agent.name || "Agent"} scheduled backup`).slice(0, 160),
      frequency,
      hourUtc,
      dayOfWeek,
      nextRunAt,
    ],
  );

  return {
    schedule: serializeSchedule(result.rows[0]),
    entitlement: subscription,
  };
}

async function syncInstallationScheduleFromSettings(actorId = null) {
  const settings = await getBackupSettings();
  const enabled = settings.installationScheduleEnabled === true;
  const frequency = normalizeFrequency(settings.installationScheduleFrequency, "daily");
  const hourUtc = clampInteger(parseInteger(settings.installationScheduleHourUtc, 2), 0, 23);
  const dayOfWeek = clampInteger(parseInteger(settings.installationScheduleDayOfWeek, 0), 0, 6);
  const nextRunAt = enabled
    ? computeNextRunAt({ frequency, hour_utc: hourUtc, day_of_week: dayOfWeek })
    : null;

  const result = await db.query(
    `INSERT INTO backup_schedules(
       schedule_key,
       kind,
       enabled,
       name,
       frequency,
       hour_utc,
       day_of_week,
       next_run_at,
       created_by,
       updated_at
     )
     VALUES('installation', 'installation', $1, 'Installation backup schedule', $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (schedule_key) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       frequency = EXCLUDED.frequency,
       hour_utc = EXCLUDED.hour_utc,
       day_of_week = EXCLUDED.day_of_week,
       next_run_at = CASE
         WHEN EXCLUDED.enabled = false THEN NULL
         WHEN backup_schedules.enabled IS DISTINCT FROM EXCLUDED.enabled
           OR backup_schedules.frequency IS DISTINCT FROM EXCLUDED.frequency
           OR backup_schedules.hour_utc IS DISTINCT FROM EXCLUDED.hour_utc
           OR backup_schedules.day_of_week IS DISTINCT FROM EXCLUDED.day_of_week
         THEN EXCLUDED.next_run_at
         ELSE backup_schedules.next_run_at
       END,
       updated_at = NOW()
     RETURNING *`,
    [enabled, frequency, hourUtc, dayOfWeek, nextRunAt, actorId],
  );
  return serializeSchedule(result.rows[0]);
}

async function processDueSchedules({ limit = 20 } = {}) {
  await syncInstallationScheduleFromSettings();
  const due = await db.query(
    `SELECT *
       FROM backup_schedules
      WHERE enabled = true
        AND next_run_at IS NOT NULL
        AND next_run_at <= NOW()
      ORDER BY next_run_at ASC
      LIMIT $1`,
    [limit],
  );

  const results = [];
  for (const schedule of due.rows) {
    const nextRunAt = computeNextRunAt(schedule);
    const claimed = await db.query(
      `UPDATE backup_schedules
          SET last_run_at = NOW(),
              next_run_at = $2,
              last_error = NULL,
              updated_at = NOW()
        WHERE id = $1
          AND enabled = true
          AND next_run_at <= NOW()
        RETURNING *`,
      [schedule.id, nextRunAt],
    );
    const row = claimed.rows[0];
    if (!row) continue;

    try {
      const backup =
        row.kind === "installation"
          ? await createInstallationBackup({
              actorId: row.created_by || row.user_id,
              name: "Scheduled installation backup",
            })
          : await createAgentBackup({
              userId: row.user_id,
              agentId: row.agent_id,
              actorId: row.created_by || row.user_id,
              name: "Scheduled agent backup",
            });
      await addBackupJob({ backupId: backup.id, scheduleId: row.id });
      await db.query(
        `UPDATE backup_schedules
            SET last_backup_id = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [row.id, backup.id],
      );
      results.push({ scheduleId: row.id, backupId: backup.id, status: "queued" });
    } catch (error) {
      await db.query(
        `UPDATE backup_schedules
            SET last_error = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [row.id, String(error.message || error).slice(0, 2000)],
      );
      results.push({ scheduleId: row.id, status: "failed", error: error.message });
    }
  }

  return results;
}

function storageKeyForBackup(backup) {
  if (!BACKUP_KINDS.has(backup?.kind)) {
    throw createHttpError(`Invalid backup kind: ${backup?.kind}`, 500);
  }
  return `${backup.kind}/${backup.id}.tgz.enc`;
}

async function markBackupFailed(backupId, error) {
  await db.query(
    `UPDATE backups
        SET status = 'failed',
            error = $2,
            updated_at = NOW()
      WHERE id = $1`,
    [backupId, String(error?.message || error || "Backup failed").slice(0, 2000)],
  );
}

async function updateBackupRunning(backupId) {
  await db.query(
    `UPDATE backups
        SET status = 'running',
            error = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [backupId],
  );
}

async function completeBackup(backup, archiveBuffer, { summary = {}, warnings = [], signal } = {}) {
  throwIfAborted(signal, "backup completion");
  await enforceBackupStorageCapacity(backup, archiveBuffer);
  const storageConfig = await backupStorageConfig();
  const storageKey = storageKeyForBackup(backup);

  // Two-phase commit: claim the storage_key on the row before uploading so
  // pruneExpiredBackups can find the bytes if anything between here and the
  // final transition fails. The row also won't get re-uploaded by an admin
  // hitting an already-completed backup id (`status = 'running'` guard).
  const claim = await db.query(
    `UPDATE backups
        SET storage_backend = $2,
            storage_key = $3,
            storage_config = $4,
            updated_at = NOW()
      WHERE id = $1 AND status = 'running'
      RETURNING id`,
    [
      backup.id,
      storageConfig.storageBackend,
      storageKey,
      JSON.stringify(backupStorageConfigSnapshot(storageConfig)),
    ],
  );
  if (claim.rowCount === 0) {
    throw createHttpError(`Backup ${backup.id} is not in 'running' state`, 409);
  }

  throwIfAborted(signal, "backup upload");
  const encrypted = encryptBackupBuffer(archiveBuffer);
  await putStorageObject(storageKey, encrypted, storageConfig, { signal });

  const status = warnings.length > 0 ? "ready_with_warnings" : "ready";
  const result = await db.query(
    `UPDATE backups
        SET status = $2,
            size_bytes = $3,
            checksum_sha256 = $4,
            summary = $5,
            warnings = $6,
            completed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      backup.id,
      status,
      archiveBuffer.length,
      sha256Hex(archiveBuffer),
      JSON.stringify(summary),
      JSON.stringify(warnings),
    ],
  );
  return serializeBackup(result.rows[0]);
}

async function enforceBackupStorageCapacity(backup, archiveBuffer) {
  if (backup.kind !== "agent" || !backup.user_id) return;
  const subscription = await billing.getSubscription(backup.user_id);
  if (billing.IS_PAAS && billing.BILLING_ENABLED && subscription.status !== "active") {
    throw createHttpError("Subscription is not active", 402);
  }
  if (!subscription.managed_backups_enabled) {
    throw createHttpError("Managed backups are not available on your current plan.", 402);
  }

  const storageLimitBytes = Number.isInteger(subscription.backup_storage_mb)
    ? subscription.backup_storage_mb * 1024 * 1024
    : null;
  if (storageLimitBytes == null) return;

  const usage = await billing.getBackupUsage(backup.user_id, { agentId: backup.agent_id });
  if (usage.backup_storage_used_bytes + archiveBuffer.length > storageLimitBytes) {
    throw createHttpError(
      "Backup storage limit reached. Delete old backups or contact your administrator.",
      402,
    );
  }
}

function backupAgentMetadata(agent = {}) {
  const runtimeFields = buildAgentRuntimeFields(agent);
  return {
    id: agent.id,
    name: agent.name,
    runtime_family: runtimeFields.runtime_family,
    deploy_target: runtimeFields.deploy_target,
    execution_target_id: runtimeFields.execution_target_id,
    sandbox_profile: runtimeFields.sandbox_profile,
    backend_type: runtimeFields.backend_type,
    sandbox_type: runtimeFields.sandbox_type,
    image: agent.image || null,
    vcpu: agent.vcpu || null,
    ram_mb: agent.ram_mb || null,
    disk_gb: agent.disk_gb || null,
    container_name: agent.container_name || null,
  };
}

async function buildAgentBackupArchive(backup, { signal } = {}) {
  throwIfAborted(signal, "agent archive build");
  const result = await db.query("SELECT * FROM agents WHERE id = $1 AND user_id = $2", [
    backup.agent_id,
    backup.user_id,
  ]);
  const agent = result.rows[0];
  if (!agent) throw createHttpError("Agent not found", 404);

  throwIfAborted(signal, "agent archive build");
  const manifest = await buildMigrationManifestFromAgent(agent, { userId: agent.user_id });
  manifest.source = {
    ...(manifest.source || {}),
    kind: "nora-backup",
    backup: {
      backupId: backup.id,
      capturedAt: new Date().toISOString(),
      agent: backupAgentMetadata(agent),
    },
  };

  return {
    buffer: await packMigrationBundle(manifest),
    summary: {
      runtimeFamily: manifest.runtimeFamily,
      sourceAgentId: agent.id,
      sourceAgentName: agent.name,
      ...(manifest.summary || {}),
    },
    warnings: Array.isArray(manifest.warnings) ? manifest.warnings : [],
  };
}

async function buildPostgresDump({ signal } = {}) {
  throwIfAborted(signal, "pg_dump");
  const args = [
    "-h",
    process.env.DB_HOST || "postgres",
    "-p",
    String(process.env.DB_PORT || "5432"),
    "-U",
    process.env.DB_USER || "nora",
    "--no-owner",
    "--no-privileges",
    "--clean",
    "--if-exists",
    process.env.DB_NAME || "nora",
  ];

  // Stream pg_dump stdout straight into gzip so we don't buffer the raw SQL
  // dump in memory. Real installations exceeded the prior 1 GiB execFile cap.
  return new Promise((resolve, reject) => {
    // Node's `spawn` natively supports AbortSignal — when the signal fires,
    // the child receives SIGTERM automatically. We still set up our own
    // settle-error path so callers see the abort reason rather than a
    // generic "Command failed" message.
    const child = spawn("pg_dump", args, {
      env: {
        ...process.env,
        PGPASSWORD: process.env.DB_PASSWORD || "nora",
      },
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });

    const gzipStream = createGzip();
    const compressedChunks = [];
    const stderrChunks = [];
    let exitCode = null;
    let exitSignal = null;
    let gzipDone = false;
    let settled = false;

    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) {
        // Clean up the subprocess on the error path. pg_dump usually exits
        // on EPIPE when stdout closes, but a hung connection (e.g., DB
        // hang during query) won't, and would otherwise outlive the worker.
        try {
          if (!child.killed) child.kill("SIGTERM");
        } catch {
          /* ignore — best effort */
        }
        reject(err);
      } else {
        resolve(value);
      }
    };

    const tryFinish = () => {
      if (exitCode === null || !gzipDone) return;
      if (exitCode !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim().slice(0, 1000);
        const detail = stderr || `signal=${exitSignal || "unknown"}`;
        return settle(new Error(`pg_dump failed (exit ${exitCode}): ${detail}`));
      }
      settle(null, Buffer.concat(compressedChunks));
    };

    child.on("error", (err) => settle(err));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("exit", (code, signal) => {
      exitCode = code ?? -1;
      exitSignal = signal;
      tryFinish();
    });

    gzipStream.on("data", (chunk) => compressedChunks.push(chunk));
    gzipStream.on("end", () => {
      gzipDone = true;
      tryFinish();
    });
    gzipStream.on("error", (err) => settle(err));

    child.stdout.on("error", (err) => settle(err));
    child.stdout.pipe(gzipStream);
  });
}

async function packInstallationArchive({ manifest, databaseDump, agentArchives }) {
  const pack = tar.pack();
  const chunks = [];
  const archivePromise = new Promise((resolve, reject) => {
    pack.on("data", (chunk) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);
  });

  async function addEntry(name, content, mode = 0o600) {
    await new Promise((resolve, reject) => {
      pack.entry({ name, mode }, content, (error) => {
        if (error) return reject(error);
        resolve();
      });
    });
  }

  await addEntry("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)), 0o644);
  await addEntry("database.sql.gz", databaseDump);
  for (const entry of agentArchives) {
    await addEntry(`agents/${entry.agentId}.nora-backup.tgz`, entry.buffer);
  }
  pack.finalize();
  const tarBuffer = await archivePromise;
  return gzipAsync(tarBuffer);
}

async function buildInstallationBackupArchive(backup, { signal } = {}) {
  throwIfAborted(signal, "installation archive build");
  const [databaseDump, agentsResult] = await Promise.all([
    buildPostgresDump({ signal }),
    db.query("SELECT * FROM agents ORDER BY created_at ASC"),
  ]);
  const warnings = [];
  const agentArchives = [];
  for (const agent of agentsResult.rows) {
    throwIfAborted(signal, "installation archive build");
    try {
      const manifest = await buildMigrationManifestFromAgent(agent, { userId: agent.user_id });
      manifest.source = {
        ...(manifest.source || {}),
        kind: "nora-installation-backup",
        backup: {
          backupId: backup.id,
          capturedAt: new Date().toISOString(),
          agent: backupAgentMetadata(agent),
        },
      };
      agentArchives.push({
        agentId: agent.id,
        buffer: await packMigrationBundle(manifest),
      });
    } catch (error) {
      warnings.push({
        code: "agent_backup_failed",
        agentId: agent.id,
        agentName: agent.name,
        message: error.message || "Agent backup failed",
      });
    }
  }

  const manifest = {
    format: BACKUP_ARCHIVE_FORMAT,
    kind: "installation",
    version: 1,
    backupId: backup.id,
    capturedAt: new Date().toISOString(),
    database: { file: "database.sql.gz" },
    agents: agentArchives.map((entry) => ({
      agentId: entry.agentId,
      file: `agents/${entry.agentId}.nora-backup.tgz`,
    })),
    warnings,
  };

  return {
    buffer: await packInstallationArchive({ manifest, databaseDump, agentArchives }),
    summary: {
      databaseDumpBytes: databaseDump.length,
      agentCount: agentsResult.rows.length,
      agentBackupCount: agentArchives.length,
      warningCount: warnings.length,
    },
    warnings,
  };
}

async function runBackupJob(backupId, { signal } = {}) {
  const backup = await loadBackup(backupId);
  if (!backup) throw createHttpError("Backup not found", 404);
  if (!["queued", "failed"].includes(backup.status)) {
    return serializeBackup(backup);
  }

  await updateBackupRunning(backup.id);
  try {
    const result =
      backup.kind === "installation"
        ? await buildInstallationBackupArchive(backup, { signal })
        : await buildAgentBackupArchive(backup, { signal });
    return await completeBackup(backup, result.buffer, {
      summary: result.summary,
      warnings: result.warnings,
      signal,
    });
  } catch (error) {
    await markBackupFailed(backup.id, error);
    throw error;
  }
}

async function readBackupArchive(backup) {
  if (!READY_STATUSES.has(backup.status)) {
    throw createHttpError("Backup is not ready", 409);
  }
  if (!backup.storage_key) {
    throw createHttpError("Backup storage object is missing", 500);
  }
  const encrypted = await getStorageObject(
    backup.storage_key,
    await backupStorageConfigForBackup(backup),
  );
  return decryptBackupBuffer(encrypted);
}

async function getBackupDownload({
  backupId,
  userId = null,
  agentId = null,
  isAdmin = false,
} = {}) {
  const backup = await loadBackup(backupId, {
    userId: isAdmin ? null : userId,
    agentId: isAdmin ? null : agentId,
  });
  if (!backup) throw createHttpError("Backup not found", 404);
  const buffer = await readBackupArchive(backup);
  const seed = (backup.name || "nora-backup")
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return {
    backup: serializeBackup(backup),
    buffer,
    filename: `${seed || "nora-backup"}.${backup.kind === "installation" ? "nora-installation-backup" : "nora-backup"}.tgz`,
  };
}

async function deleteBackup({ backupId, userId = null, agentId = null, isAdmin = false } = {}) {
  const backup = await loadBackup(backupId, {
    userId: isAdmin ? null : userId,
    agentId: isAdmin ? null : agentId,
  });
  if (!backup) throw createHttpError("Backup not found", 404);
  await deleteStorageObject(backup.storage_key, await backupStorageConfigForBackup(backup));
  await db.query(
    `UPDATE backups
        SET status = 'deleted',
            storage_key = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [backup.id],
  );
  return { success: true };
}

async function createRestoreDraft({ backupId, userId, agentId = null }) {
  const backup = await loadBackup(backupId, { userId, agentId });
  if (!backup || backup.kind !== "agent") throw createHttpError("Backup not found", 404);
  const subscription = await billing.getSubscription(userId);
  if (billing.IS_PAAS && billing.BILLING_ENABLED && subscription.status !== "active") {
    throw createHttpError("Subscription is not active", 402);
  }
  if (!subscription.managed_backups_enabled) {
    throw createHttpError("Managed backup restore is not available on your current plan.", 402);
  }
  const buffer = await readBackupArchive(backup);
  const manifest = await parseUploadedMigrationBuffer(buffer, `${backup.id}.nora-backup.tgz`, {
    maxBytes: null,
  });
  const restoredName = `${manifest.name || backup.name || "Restored Agent"} Restore`;
  manifest.name = restoredName.slice(0, 100);
  manifest.source = {
    ...(manifest.source || {}),
    restore: {
      backupId: backup.id,
      restoredAt: new Date().toISOString(),
      mode: "copy",
    },
  };
  const draft = await createMigrationDraft({
    userId,
    manifest,
    sourceKind: "backup",
    sourceTransport: "managed-backup",
  });
  const agentMeta = manifest.source?.backup?.agent || {};
  const runtimeFields = buildAgentRuntimeFields({
    runtime_family: manifest.runtimeFamily,
    ...agentMeta,
  });
  return {
    draft: draft.preview,
    deployDraft: {
      name: draft.preview.name,
      containerName: "",
      runtimeFamily: runtimeFields.runtime_family,
      deployTarget: runtimeFields.execution_target_id || runtimeFields.deploy_target,
      sandboxProfile: runtimeFields.sandbox_profile,
      model: "",
      deploymentMode: "migrate",
      migrationMethod: "backup",
      migrationDraft: draft.preview,
      migrationSource: {
        transport: "backup",
        backupId: backup.id,
        name: backup.name,
      },
      vcpu: agentMeta.vcpu || 1,
      ramMb: agentMeta.ram_mb || 1024,
      diskGb: agentMeta.disk_gb || 10,
      clawhubSkills: [],
    },
  };
}

function assertRuntimeSelectionAvailable(runtimeFields) {
  const status = getRuntimeSelectionStatus(runtimeFields);
  if (!status.enabled || !status.configured) {
    throw createHttpError(
      status.issue || "Runtime selection is not enabled for this Nora control plane.",
      400,
    );
  }
}

async function restoreBackupInPlace({ backupId, targetAgentId, confirmAgentName, actor } = {}) {
  const backup = await loadBackup(backupId);
  if (!backup || backup.kind !== "agent") throw createHttpError("Backup not found", 404);
  const targetResult = await db.query("SELECT * FROM agents WHERE id = $1", [
    targetAgentId || backup.agent_id,
  ]);
  const target = targetResult.rows[0];
  if (!target) throw createHttpError("Target agent not found", 404);
  if (backup.agent_id && target.id !== backup.agent_id) {
    throw createHttpError("In-place restore can only target the backed-up agent", 400);
  }
  // Defense-in-depth: routes/admin.ts gates this behind requireAdmin today,
  // but enforce ownership inside the helper too so a future tenant route
  // can't accidentally bypass it. Admins may restore across tenants;
  // non-admins must own both the backup and the target.
  const isAdmin = actor?.role === "admin";
  if (!isAdmin) {
    if (!actor?.id || target.user_id !== actor.id || backup.user_id !== actor.id) {
      throw createHttpError("Not authorized to restore this backup", 403);
    }
  }
  if (String(confirmAgentName || "") !== String(target.name || "")) {
    throw createHttpError("confirmAgentName must match the target agent name", 400);
  }

  const buffer = await readBackupArchive(backup);
  const manifest = await parseUploadedMigrationBuffer(buffer, `${backup.id}.nora-backup.tgz`, {
    maxBytes: null,
  });
  const targetRuntime = buildAgentRuntimeFields(target);
  if (manifest.runtimeFamily !== targetRuntime.runtime_family) {
    throw createHttpError(
      "In-place restore requires the same runtime family as the target agent",
      400,
    );
  }

  const sourceAgentMeta = manifest.source?.backup?.agent || {};
  const runtimeFields = resolveRequestedRuntimeFields({
    request: targetRuntime,
    fallback: targetRuntime,
  });
  assertRuntimeSelectionAvailable(runtimeFields);
  // Deep execution-target checks (parity with the deploy route): the cluster /
  // remote host must still exist + be connected. Owner-scoped to the target
  // agent's owner so an admin cross-tenant restore still validates against the
  // owner's registered host, not the admin actor.
  await assertKubernetesExecutionTargetAvailable(runtimeFields);
  await assertRemoteHostExecutionTargetAvailable(runtimeFields, { ownerUserId: target.user_id });
  const containerName = resolveContainerName({
    currentName: target.container_name,
    agentName: target.name,
    runtimeSelection: runtimeFields,
  });
  const image =
    target.image ||
    sourceAgentMeta.image ||
    getDefaultAgentImage({
      runtime_family: runtimeFields.runtime_family,
      sandbox_profile: runtimeFields.sandbox_profile,
    });
  const templatePayload =
    manifest.runtimeFamily === "openclaw"
      ? manifest.templatePayload || createEmptyTemplatePayload({ source: "backup-restore" })
      : createEmptyTemplatePayload({ source: "backup-restore", backupId: backup.id });

  await db.query("DELETE FROM integrations WHERE agent_id = $1", [target.id]);
  await db.query("DELETE FROM channels WHERE agent_id = $1", [target.id]);
  await materializeManagedMigrationState(target.user_id, target.id, manifest);

  if (manifest.runtimeFamily === "openclaw") {
    const hasManagedWiring =
      (manifest.managed?.channels || []).length > 0 ||
      (manifest.managed?.integrations || []).length > 0;
    if (!hasManagedWiring) {
      await materializeTemplateWiring(target.id, manifest.templatePayload || {});
    }
  }

  const updated = await db.query(
    `UPDATE agents
        SET status = 'queued',
            container_id = NULL,
            host = NULL,
            runtime_host = NULL,
            runtime_port = NULL,
            gateway_host = NULL,
            gateway_port = NULL,
            gateway_host_port = NULL,
            gateway_token = NULL,
            template_payload = $2,
            container_name = $3,
            image = $4
      WHERE id = $1
      RETURNING *`,
    [target.id, JSON.stringify(templatePayload), containerName, image],
  );
  const agent = updated.rows[0];

  await db.query("INSERT INTO deployments(agent_id, status) VALUES($1, 'queued')", [agent.id]);
  await addDeploymentJob({
    id: agent.id,
    name: agent.name,
    userId: agent.user_id,
    backend: runtimeFields.backend_type,
    sandbox: runtimeFields.sandbox_profile,
    specs: {
      vcpu: agent.vcpu || sourceAgentMeta.vcpu || 1,
      ram_mb: agent.ram_mb || sourceAgentMeta.ram_mb || 1024,
      disk_gb: agent.disk_gb || sourceAgentMeta.disk_gb || 10,
    },
    container_name: containerName,
    image,
    backup_restore_id: backup.id,
  });

  await db.query(
    `UPDATE backups
        SET restore_metadata = $2,
            updated_at = NOW()
      WHERE id = $1`,
    [
      backup.id,
      JSON.stringify({
        mode: "in_place",
        targetAgentId: agent.id,
        restoredAt: new Date().toISOString(),
        actorId: actor?.id || null,
      }),
    ],
  );

  return serializeAgent(agent);
}

async function pruneExpiredBackups() {
  // Garbage collects two classes of rows:
  //   1. Expired backups (past expires_at) — flip to 'deleted' once the
  //      storage object is gone.
  //   2. Orphaned 'failed' rows that wrote a storage key before the failure
  //      — keeps S3/SSH/local from accumulating zombie objects when the
  //      final completeBackup UPDATE didn't land.
  // If storage delete fails, we leave the row alone and retry next pass
  // rather than marking it deleted with the bytes still on disk.
  const result = await db.query(
    `SELECT *
       FROM backups
      WHERE storage_key IS NOT NULL
        AND status <> 'deleted'
        AND (
          (expires_at IS NOT NULL AND expires_at < NOW())
          OR (status = 'failed' AND updated_at < NOW() - INTERVAL '24 hours')
        )`,
  );

  let deleted = 0;
  for (const backup of result.rows) {
    let storageGone = false;
    try {
      await deleteStorageObject(backup.storage_key, await backupStorageConfigForBackup(backup));
      storageGone = true;
    } catch (error) {
      console.warn(
        `[backups] prune: failed to delete storage for backup=${backup.id} key=${backup.storage_key}: ${error?.message || error}`,
      );
    }

    if (!storageGone) continue;

    await db.query(
      `UPDATE backups
          SET status = 'deleted',
              storage_key = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [backup.id],
    );
    deleted += 1;
  }
  return { deleted, scanned: result.rows.length };
}

module.exports = {
  BACKUP_ARCHIVE_FORMAT,
  BACKUP_KINDS,
  createAgentBackup,
  createInstallationBackup,
  createRestoreDraft,
  deleteBackup,
  getAgentBackupSchedule,
  getBackupDownload,
  listAdminBackups,
  listAgentBackups,
  processDueSchedules,
  pruneExpiredBackups,
  runBackupJob,
  restoreBackupInPlace,
  serializeBackup,
  storageKeyForBackup,
  syncInstallationScheduleFromSettings,
  updateAgentBackupSchedule,
};
