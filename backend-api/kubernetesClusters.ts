// @ts-nocheck
const db = require("./db");
const { decrypt, encrypt, ensureEncryptionConfigured } = require("./crypto");
const {
  getExecutionTargetMetadata,
  normalizeDeployTargetName,
  normalizeExecutionTargetId,
} = require("../agent-runtime/lib/backendCatalog");

const PROVIDERS = new Set(["kubernetes", "k3s", "aks", "gke", "eks"]);
const CREDENTIAL_MODES = new Set(["encrypted_kubeconfig", "mounted_path"]);
const EXPOSURE_MODES = new Set(["cluster-ip", "node-port", "load-balancer"]);
let k8sClient = null;

function getK8sClient() {
  if (!k8sClient) {
    k8sClient = require("@kubernetes/client-node");
  }
  return k8sClient;
}

function formatKubeconfigLoadError(profile, error) {
  const label = profile.label || profile.executionTargetId || profile.id || "Kubernetes cluster";
  const kubeconfigPath = normalizeText(profile.kubeconfigPath);
  if (kubeconfigPath && error?.code === "ENOENT") {
    return `${label} mounted kubeconfig file was not found at ${kubeconfigPath}. Make sure NORA_KUBECONFIGS_DIR is mounted with docker-compose.kubernetes.yml and contains this file, or update the Admin Kubeconfig path to the file visible inside the Nora containers.`;
  }
  if (kubeconfigPath && error?.code === "EACCES") {
    return `${label} mounted kubeconfig file is not readable at ${kubeconfigPath}. Make sure the file is readable by the backend-api and worker-provisioner containers.`;
  }
  if (kubeconfigPath) {
    return `${label} mounted kubeconfig file at ${kubeconfigPath} could not be loaded: ${error?.message || "unknown error"}`;
  }
  return error?.message || "Kubernetes kubeconfig could not be loaded.";
}

function hasText(value) {
  return typeof value === "string" ? value.trim() !== "" : value != null;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSlug(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function normalizeClusterId(value, fallbackLabel = "") {
  const normalized = normalizeSlug(value) || normalizeSlug(fallbackLabel);
  if (!normalized) {
    const error = new Error("Cluster id is required");
    error.statusCode = 400;
    throw error;
  }
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(normalized)) {
    const error = new Error("Cluster id must be 2-64 lowercase letters, numbers, or dashes");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeProvider(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["azure", "azure-aks"].includes(normalized)) return "aks";
  if (["google", "google-gke"].includes(normalized)) return "gke";
  if (["aws", "aws-eks"].includes(normalized)) return "eks";
  return PROVIDERS.has(normalized) ? normalized : "kubernetes";
}

function normalizeCredentialMode(value, fallback = "mounted_path") {
  const normalized = normalizeText(value).toLowerCase();
  return CREDENTIAL_MODES.has(normalized) ? normalized : fallback;
}

function normalizeExposureMode(value, fallback = "cluster-ip") {
  const normalized = normalizeText(value).toLowerCase();
  const canonical = normalized === "loadbalancer" ? "load-balancer" : normalized;
  return EXPOSURE_MODES.has(canonical) ? canonical : fallback;
}

function parseInteger(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = parseInteger(value, fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePort(value) {
  const parsed = parseInteger(value, null);
  if (!Number.isFinite(parsed)) return null;
  return parsed >= 1 && parsed <= 65535 ? parsed : null;
}

function parseJsonObject(value, fallback = {}) {
  if (value == null || value === "") return fallback;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function parseStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeText(entry)).filter(Boolean);
  }
  return normalizeText(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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

function maskCluster(row) {
  const profile = rowToProfile(row, { includeSecret: false });
  return {
    ...profile,
    hasEncryptedKubeconfig: Boolean(row?.kubeconfig_encrypted),
    kubeconfigContent: undefined,
  };
}

function rowToProfile(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const id = normalizeClusterId(row.id || row.cluster_id || row.label || "cluster");
  const provider = normalizeProvider(row.provider);
  const namespace = normalizeText(row.namespace) || "openclaw-agents";
  const openclawNamespace = normalizeText(row.openclaw_namespace) || namespace;
  const hermesNamespace = normalizeText(row.hermes_namespace) || namespace;
  const executionTargetId = `k8s:${id}`;
  const exposureMode = normalizeExposureMode(row.exposure_mode);
  const metadata = getExecutionTargetMetadata("k8s", {
    provider,
    providerLabel: row.provider_label || "",
  });
  const clusterName = normalizeText(row.cluster_name);
  const label = normalizeText(row.label) || clusterName || metadata.label || "Kubernetes";
  const configured =
    row.credential_mode === "encrypted_kubeconfig"
      ? Boolean(row.kubeconfig_encrypted)
      : Boolean(normalizeText(row.kubeconfig_path));
  const testedOk = row.last_test_status === "ok";
  const issue = !configured
    ? row.credential_mode === "encrypted_kubeconfig"
      ? "Kubernetes cluster requires encrypted kubeconfig content."
      : "Kubernetes cluster requires a mounted kubeconfig path."
    : !testedOk
      ? row.last_test_status === "failed"
        ? row.last_test_message || "Kubernetes cluster connection test failed."
        : "Kubernetes cluster must pass the Admin connection test before deployment."
      : null;

  let kubeconfigContent = null;
  if (includeSecret && row.kubeconfig_encrypted) {
    kubeconfigContent = decrypt(row.kubeconfig_encrypted);
  }

  return {
    id,
    executionTargetId,
    adapter: "k8s",
    deployTarget: "k8s",
    label,
    shortLabel: label,
    provider,
    providerId: provider,
    providerLabel: metadata.providerLabel || metadata.shortLabel || metadata.label,
    clusterName,
    enabled: row.enabled !== false,
    isDefault: row.is_default === true,
    credentialMode: row.credential_mode || "mounted_path",
    kubeconfigPath: normalizeText(row.kubeconfig_path),
    kubeconfigContent,
    kubeContext: normalizeText(row.kube_context),
    namespace,
    openclawNamespace,
    hermesNamespace,
    runtimeNamespaces: {
      openclaw: openclawNamespace,
      hermes: hermesNamespace,
    },
    exposureMode,
    runtimeHost: normalizeText(row.runtime_host),
    runtimeNodePort: parsePort(row.runtime_node_port),
    gatewayNodePort: parsePort(row.gateway_node_port),
    serviceAnnotations: parseJsonObject(row.service_annotations, {}),
    loadBalancerSourceRanges: parseStringArray(row.load_balancer_source_ranges),
    loadBalancerClass: normalizeText(row.load_balancer_class),
    loadBalancerReadyTimeoutMs: parsePositiveInteger(row.load_balancer_ready_timeout_ms, 600000),
    loadBalancerReadyIntervalMs: parsePositiveInteger(row.load_balancer_ready_interval_ms, 5000),
    configured,
    connected: testedOk,
    available: row.enabled !== false && configured && testedOk,
    issue,
    summary:
      clusterName && clusterName !== label
        ? `${metadata.summary} Cluster: ${clusterName}.`
        : metadata.summary,
    detail:
      `${clusterName ? `Cluster ${clusterName}` : metadata.detail} · ` +
      `${openclawNamespace === hermesNamespace ? `namespace ${openclawNamespace}` : `OpenClaw ${openclawNamespace}, Hermes ${hermesNamespace}`} · ` +
      exposureMode,
    badges: [
      metadata.providerLabel || metadata.shortLabel || "Kubernetes",
      exposureMode,
      openclawNamespace,
    ].filter(Boolean),
    lastTestStatus: row.last_test_status || null,
    lastTestMessage: row.last_test_message || null,
    lastTestedAt: row.last_tested_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function normalizeClusterInput(input = {}, existing = null) {
  const label = normalizeText(input.label ?? existing?.label);
  const id = existing
    ? normalizeClusterId(existing.id)
    : normalizeClusterId(input.id || input.clusterId, label);
  const credentialMode = normalizeCredentialMode(
    input.credentialMode ?? input.credential_mode,
    existing?.credential_mode || "mounted_path",
  );
  const kubeconfigContent = normalizeText(input.kubeconfigContent ?? input.kubeconfig_content);
  const clearKubeconfig = normalizeBool(input.clearKubeconfig ?? input.clear_kubeconfig, false);

  if (credentialMode === "encrypted_kubeconfig" && kubeconfigContent) {
    ensureEncryptionConfigured("Kubernetes kubeconfig storage");
  }

  let kubeconfigEncrypted = existing?.kubeconfig_encrypted || null;
  if (clearKubeconfig) kubeconfigEncrypted = null;
  if (credentialMode === "encrypted_kubeconfig" && kubeconfigContent) {
    kubeconfigEncrypted = encrypt(kubeconfigContent);
  }

  const serviceAnnotations = parseJsonObject(
    input.serviceAnnotations ?? input.service_annotations,
    existing?.service_annotations || {},
  );

  return {
    id,
    label: label || id,
    provider: normalizeProvider(input.provider ?? existing?.provider),
    clusterName: normalizeText(input.clusterName ?? input.cluster_name ?? existing?.cluster_name),
    enabled: normalizeBool(input.enabled, existing?.enabled ?? true),
    isDefault: normalizeBool(input.isDefault ?? input.is_default, existing?.is_default ?? false),
    credentialMode,
    kubeconfigPath: normalizeText(
      input.kubeconfigPath ?? input.kubeconfig_path ?? existing?.kubeconfig_path,
    ),
    kubeconfigEncrypted,
    kubeContext: normalizeText(input.kubeContext ?? input.kube_context ?? existing?.kube_context),
    namespace:
      normalizeText(input.namespace ?? existing?.namespace) ||
      normalizeText(input.openclawNamespace ?? input.openclaw_namespace) ||
      "openclaw-agents",
    openclawNamespace: normalizeText(
      input.openclawNamespace ?? input.openclaw_namespace ?? existing?.openclaw_namespace,
    ),
    hermesNamespace: normalizeText(
      input.hermesNamespace ?? input.hermes_namespace ?? existing?.hermes_namespace,
    ),
    exposureMode: normalizeExposureMode(
      input.exposureMode ?? input.exposure_mode,
      existing?.exposure_mode,
    ),
    runtimeHost: normalizeText(input.runtimeHost ?? input.runtime_host ?? existing?.runtime_host),
    runtimeNodePort:
      parsePort(input.runtimeNodePort ?? input.runtime_node_port) ??
      existing?.runtime_node_port ??
      null,
    gatewayNodePort:
      parsePort(input.gatewayNodePort ?? input.gateway_node_port) ??
      existing?.gateway_node_port ??
      null,
    serviceAnnotations,
    loadBalancerSourceRanges: parseStringArray(
      input.loadBalancerSourceRanges ??
        input.load_balancer_source_ranges ??
        existing?.load_balancer_source_ranges,
    ),
    loadBalancerClass: normalizeText(
      input.loadBalancerClass ?? input.load_balancer_class ?? existing?.load_balancer_class,
    ),
    loadBalancerReadyTimeoutMs: parsePositiveInteger(
      input.loadBalancerReadyTimeoutMs ??
        input.load_balancer_ready_timeout_ms ??
        existing?.load_balancer_ready_timeout_ms,
      600000,
    ),
    loadBalancerReadyIntervalMs: parsePositiveInteger(
      input.loadBalancerReadyIntervalMs ??
        input.load_balancer_ready_interval_ms ??
        existing?.load_balancer_ready_interval_ms,
      5000,
    ),
  };
}

function clusterConnectionInputChanged(existing, cluster) {
  if (!existing) return false;
  return (
    normalizeText(existing.credential_mode) !== cluster.credentialMode ||
    normalizeText(existing.kubeconfig_path) !== cluster.kubeconfigPath ||
    normalizeText(existing.kubeconfig_encrypted) !== normalizeText(cluster.kubeconfigEncrypted) ||
    normalizeText(existing.kube_context) !== cluster.kubeContext
  );
}

async function listKubernetesClusters(options = {}) {
  const includeDisabled = options.includeDisabled !== false;
  const includeSecret = options.includeSecret === true;
  try {
    const result = await db.query(
      `SELECT *
         FROM kubernetes_clusters
        ${includeDisabled ? "" : "WHERE enabled = true"}
        ORDER BY is_default DESC, label ASC, id ASC`,
    );
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    return rows.map((row) =>
      includeSecret ? rowToProfile(row, { includeSecret: true }) : maskCluster(row),
    );
  } catch (error) {
    if (error?.code === "42P01") return [];
    throw error;
  }
}

async function listKubernetesExecutionTargets() {
  const clusters = await listKubernetesClusters({ includeDisabled: false });
  return clusters.filter((cluster) => cluster.available);
}

async function getClusterRow(clusterId) {
  const id = normalizeClusterId(clusterId);
  const result = await db.query("SELECT * FROM kubernetes_clusters WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function createKubernetesCluster(input = {}) {
  const cluster = normalizeClusterInput(input);
  const result = await db.query(
    `INSERT INTO kubernetes_clusters(
       id, label, provider, cluster_name, enabled, is_default, credential_mode,
       kubeconfig_path, kubeconfig_encrypted, kube_context, namespace,
       openclaw_namespace, hermes_namespace, exposure_mode, runtime_host,
       runtime_node_port, gateway_node_port, service_annotations,
       load_balancer_source_ranges, load_balancer_class,
       load_balancer_ready_timeout_ms, load_balancer_ready_interval_ms
     ) VALUES(
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13, $14, $15,
       $16, $17, $18::jsonb,
       $19::text[], $20,
       $21, $22
     )
     RETURNING *`,
    [
      cluster.id,
      cluster.label,
      cluster.provider,
      cluster.clusterName,
      cluster.enabled,
      cluster.isDefault,
      cluster.credentialMode,
      cluster.kubeconfigPath,
      cluster.kubeconfigEncrypted,
      cluster.kubeContext,
      cluster.namespace,
      cluster.openclawNamespace,
      cluster.hermesNamespace,
      cluster.exposureMode,
      cluster.runtimeHost,
      cluster.runtimeNodePort,
      cluster.gatewayNodePort,
      JSON.stringify(cluster.serviceAnnotations),
      cluster.loadBalancerSourceRanges,
      cluster.loadBalancerClass,
      cluster.loadBalancerReadyTimeoutMs,
      cluster.loadBalancerReadyIntervalMs,
    ],
  );
  if (cluster.isDefault) {
    await db.query("UPDATE kubernetes_clusters SET is_default = false WHERE id <> $1", [
      cluster.id,
    ]);
  }
  return maskCluster(result.rows[0]);
}

async function updateKubernetesCluster(clusterId, input = {}) {
  const existing = await getClusterRow(clusterId);
  if (!existing) {
    const error = new Error("Kubernetes cluster not found");
    error.statusCode = 404;
    throw error;
  }
  const cluster = normalizeClusterInput(input, existing);
  const connectionInputChanged = clusterConnectionInputChanged(existing, cluster);
  const result = await db.query(
    `UPDATE kubernetes_clusters
        SET label = $2,
            provider = $3,
            cluster_name = $4,
            enabled = $5,
            is_default = $6,
            credential_mode = $7,
            kubeconfig_path = $8,
            kubeconfig_encrypted = $9,
            kube_context = $10,
            namespace = $11,
            openclaw_namespace = $12,
            hermes_namespace = $13,
            exposure_mode = $14,
            runtime_host = $15,
            runtime_node_port = $16,
            gateway_node_port = $17,
            service_annotations = $18::jsonb,
            load_balancer_source_ranges = $19::text[],
            load_balancer_class = $20,
            load_balancer_ready_timeout_ms = $21,
            load_balancer_ready_interval_ms = $22,
            last_test_status = CASE WHEN $23 THEN NULL ELSE last_test_status END,
            last_test_message = CASE WHEN $23 THEN NULL ELSE last_test_message END,
            last_tested_at = CASE WHEN $23 THEN NULL ELSE last_tested_at END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      existing.id,
      cluster.label,
      cluster.provider,
      cluster.clusterName,
      cluster.enabled,
      cluster.isDefault,
      cluster.credentialMode,
      cluster.kubeconfigPath,
      cluster.kubeconfigEncrypted,
      cluster.kubeContext,
      cluster.namespace,
      cluster.openclawNamespace,
      cluster.hermesNamespace,
      cluster.exposureMode,
      cluster.runtimeHost,
      cluster.runtimeNodePort,
      cluster.gatewayNodePort,
      JSON.stringify(cluster.serviceAnnotations),
      cluster.loadBalancerSourceRanges,
      cluster.loadBalancerClass,
      cluster.loadBalancerReadyTimeoutMs,
      cluster.loadBalancerReadyIntervalMs,
      connectionInputChanged,
    ],
  );
  if (cluster.isDefault) {
    await db.query("UPDATE kubernetes_clusters SET is_default = false WHERE id <> $1", [
      existing.id,
    ]);
  }
  return maskCluster(result.rows[0]);
}

async function deleteKubernetesCluster(clusterId) {
  const id = normalizeClusterId(clusterId);
  const executionTargetId = `k8s:${id}`;
  const usage = await db.query(
    "SELECT COUNT(*)::int AS count FROM agents WHERE execution_target_id = $1 AND status <> 'deleted'",
    [executionTargetId],
  );
  if ((usage.rows[0]?.count || 0) > 0) {
    const error = new Error("Cannot delete a Kubernetes cluster while agents still reference it");
    error.statusCode = 409;
    throw error;
  }
  const result = await db.query("DELETE FROM kubernetes_clusters WHERE id = $1 RETURNING *", [id]);
  if (!result.rows[0]) {
    const error = new Error("Kubernetes cluster not found");
    error.statusCode = 404;
    throw error;
  }
  return maskCluster(result.rows[0]);
}

async function getKubernetesClusterProfile(executionTargetId) {
  const normalized = normalizeExecutionTargetId(executionTargetId);
  if (!normalized || normalized === "k8s") return null;
  if (!normalized.startsWith("k8s:")) return null;

  const row = await getClusterRow(normalized.slice(4));
  return rowToProfile(row, { includeSecret: true });
}

async function assertKubernetesExecutionTargetAvailable(runtimeFields = {}) {
  if (normalizeDeployTargetName(runtimeFields.deploy_target) !== "k8s") return null;
  const executionTargetId = normalizeExecutionTargetId(
    runtimeFields.execution_target_id ||
      runtimeFields.executionTargetId ||
      runtimeFields.deploy_target,
  );
  if (!executionTargetId || executionTargetId === "k8s" || !executionTargetId.startsWith("k8s:")) {
    const error = new Error(
      "Kubernetes deployments require an Admin-registered cluster target such as k8s:aks-eastus2.",
    );
    error.statusCode = 400;
    throw error;
  }

  const profile = await getKubernetesClusterProfile(executionTargetId);
  if (!profile) {
    const error = new Error(`Unknown Kubernetes execution target: ${executionTargetId}`);
    error.statusCode = 400;
    throw error;
  }
  if (!profile.enabled) {
    const error = new Error(`${profile.label} is disabled for new deployments.`);
    error.statusCode = 400;
    throw error;
  }
  if (!profile.configured) {
    const error = new Error(profile.issue || `${profile.label} is not configured.`);
    error.statusCode = 400;
    throw error;
  }
  if (!profile.connected) {
    const error = new Error(
      profile.issue || `${profile.label} must pass the Admin connection test before deployment.`,
    );
    error.statusCode = 400;
    throw error;
  }
  return profile;
}

function buildKubeConfig(profile) {
  const k8s = getK8sClient();
  const kc = new k8s.KubeConfig();
  try {
    if (profile.kubeconfigContent) {
      kc.loadFromString(profile.kubeconfigContent);
    } else if (profile.kubeconfigPath) {
      kc.loadFromFile(profile.kubeconfigPath);
    } else {
      kc.loadFromCluster();
    }
  } catch (error) {
    const wrapped = new Error(formatKubeconfigLoadError(profile, error));
    wrapped.cause = error;
    throw wrapped;
  }
  if (profile.kubeContext && typeof kc.setCurrentContext === "function") {
    kc.setCurrentContext(profile.kubeContext);
  }
  return kc;
}

async function testKubernetesCluster(clusterId) {
  const profile = await getKubernetesClusterProfile(`k8s:${clusterId}`);
  if (!profile) {
    const error = new Error("Kubernetes cluster not found");
    error.statusCode = 404;
    throw error;
  }
  let status = "ok";
  let message = "Kubernetes API is reachable.";
  if (!profile.configured) {
    status = "failed";
    message = profile.issue || "Kubernetes cluster is not configured.";
  } else {
    try {
      const k8s = getK8sClient();
      const kc = buildKubeConfig(profile);
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);
      await coreApi.listNamespace({ limit: 1 });
    } catch (error) {
      status = "failed";
      message = error?.message || "Kubernetes API test failed.";
    }
  }
  const result = await db.query(
    `UPDATE kubernetes_clusters
        SET last_test_status = $2,
            last_test_message = $3,
            last_tested_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [profile.id, status, message],
  );
  return maskCluster(result.rows[0]);
}

module.exports = {
  assertKubernetesExecutionTargetAvailable,
  createKubernetesCluster,
  deleteKubernetesCluster,
  getKubernetesClusterProfile,
  listKubernetesClusters,
  listKubernetesExecutionTargets,
  rowToProfile,
  testKubernetesCluster,
  updateKubernetesCluster,
};
