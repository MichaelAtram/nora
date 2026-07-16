// @ts-nocheck
// Synchronizes provider, integration, and model auth into live OpenClaw and
// Hermes agents. OpenClaw profiles are written through the runtime sidecar
// when possible; Hermes receives a managed environment and model config.
// Backends restart afterward because runtime auth is not hot-reloaded.

const db = require("./db");
const containerManager = require("./containerManager");
const llmProviders = require("./llmProviders");
const { runtimeUrlForAgent } = require("../agent-runtime/lib/agentEndpoints");
const { runtimeAuthHeaders } = require("./runtimeAuth");
const { waitForAgentReadiness } = require("./healthChecks");
const { resolveAgentRuntimeFamily } = require("./agentRuntimeFields");
const { shellSingleQuote } = require("../agent-runtime/lib/containerCommand");
const {
  buildOpenClawAuthProfilesWriteCommand,
  buildOpenClawConfigMergeCommand,
  buildOpenClawCustomProviders,
  buildOpenClawDefaultModelCommand,
  buildOpenClawModelForProvider,
} = require("../agent-runtime/lib/runtimeBootstrap");
const { buildHermesRuntimeBootstrapEnv } = require("../agent-runtime/lib/hermesRuntimeBootstrap");
const { NEMOCLAW_DEFAULT_MODEL } = require("../agent-runtime/lib/nemoclawDefaults");

const providerCatalog = Array.isArray(llmProviders.PROVIDERS)
  ? llmProviders.PROVIDERS
  : typeof llmProviders.getAvailableProviders === "function"
    ? llmProviders.getAvailableProviders()
    : [];
const providerCatalogById = new Map(providerCatalog.map((provider) => [provider.id, provider]));
const LLM_ENV_VARS = new Set(providerCatalog.map((provider) => provider.envVar).filter(Boolean));

const PROVIDER_MODEL_DEFAULTS = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.5",
  google: "gemini-3.1-pro-preview",
  groq: "llama-3.3-70b-versatile",
  mistral: "mistral-large-latest",
  deepseek: "deepseek-chat",
  openrouter: "openrouter/auto",
  together: "together/moonshotai/Kimi-K2.5",
  cohere: "command-r-plus",
  xai: "grok-4",
  nvidia: NEMOCLAW_DEFAULT_MODEL,
  moonshot: "kimi-k2.5",
  zai: "glm-5",
  minimax: "MiniMax-M2.7",
  // Bare deployment name — buildDefaultModelCommand prefixes it with the
  // OpenClaw provider id (azure-openai-responses) via buildOpenClawModelForProvider.
  "microsoft-foundry": "gpt-5.5-1",
};

const HERMES_NATIVE_PROVIDER_MAP = Object.freeze({
  anthropic: Object.freeze({ provider: "anthropic" }),
  deepseek: Object.freeze({ provider: "deepseek" }),
  google: Object.freeze({ provider: "gemini" }),
  huggingface: Object.freeze({ provider: "huggingface" }),
  minimax: Object.freeze({ provider: "minimax" }),
  moonshot: Object.freeze({ provider: "kimi-coding" }),
  openrouter: Object.freeze({
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  }),
  xai: Object.freeze({ provider: "xai" }),
  zai: Object.freeze({ provider: "zai" }),
});

const HERMES_CUSTOM_PROVIDER_BASE_URLS = Object.freeze({
  cerebras: "https://api.cerebras.ai/v1",
  cohere: "https://api.cohere.ai/compatibility/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  openai: "https://api.openai.com/v1",
  together: "https://api.together.xyz/v1",
});

const CONTAINER_EXEC_AUTH_FALLBACK_BACKENDS = new Set(["docker", "proxmox"]);

// Provider and model normalization

function normalizeProviderConfig(config) {
  if (!config) return {};
  if (typeof config === "string") {
    try {
      const parsed = JSON.parse(config);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof config === "object" && !Array.isArray(config) ? config : {};
}

function pickProviderBaseUrl(config = {}) {
  for (const key of ["base_url", "baseUrl", "endpoint", "url"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function getProviderEnvVar(providerId) {
  return providerCatalogById.get(providerId)?.envVar || "";
}

function normalizeUrlForCompare(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function resolveHermesModelApiKey(defaultProvider = null, envVars = {}) {
  const providerId = String(defaultProvider?.provider || "").trim();
  const envVar = getProviderEnvVar(providerId);
  return envVar && envVars?.[envVar] ? String(envVars[envVar]) : "";
}

function attachHermesCustomApiKey(modelConfig = null, defaultProvider = null, envVars = {}) {
  if (!modelConfig || String(modelConfig.provider || "").trim() !== "custom") return modelConfig;

  const apiKey = resolveHermesModelApiKey(defaultProvider, envVars);
  if (!apiKey) return modelConfig;

  const defaultBaseUrl = resolveHermesProviderBaseUrl(defaultProvider);
  const modelBaseUrl = String(modelConfig.baseUrl || "").trim();
  if (
    modelBaseUrl &&
    defaultBaseUrl &&
    normalizeUrlForCompare(modelBaseUrl) !== normalizeUrlForCompare(defaultBaseUrl)
  ) {
    return modelConfig;
  }

  return { ...modelConfig, apiKey };
}

function resolveHermesProviderBaseUrl(defaultProvider = null) {
  if (!defaultProvider) return "";
  const providerId = String(defaultProvider.provider || "").trim();
  if (!providerId) return "";

  const savedConfig = normalizeProviderConfig(defaultProvider.config);
  const savedBaseUrl = pickProviderBaseUrl(savedConfig);
  const catalogBaseUrl =
    typeof providerCatalogById.get(providerId)?.endpoint === "string"
      ? providerCatalogById.get(providerId).endpoint.trim()
      : "";

  return savedBaseUrl || catalogBaseUrl || HERMES_CUSTOM_PROVIDER_BASE_URLS[providerId] || "";
}

/**
 * Translate a saved default provider into Hermes' native or custom model configuration.
 *
 * @param {Object|null} [defaultProvider=null] - Saved provider, model, and endpoint settings.
 * @param {Object} [envVars={}] - Managed environment values that may contain its API key.
 * @returns {Object|null} Hermes model configuration, or `null` when no default is configured.
 * @throws {Error} When the provider lacks a required id, model, or custom base URL.
 */
function buildHermesModelConfig(defaultProvider = null, envVars = {}) {
  if (!defaultProvider) return null;

  const providerId = String(defaultProvider.provider || "").trim();
  if (!providerId) {
    throw new Error("Default LLM provider is missing a provider id");
  }

  const savedConfig = normalizeProviderConfig(defaultProvider.config);
  const savedBaseUrl = pickProviderBaseUrl(savedConfig);
  const modelId =
    typeof defaultProvider.model === "string" && defaultProvider.model.trim()
      ? defaultProvider.model.trim()
      : PROVIDER_MODEL_DEFAULTS[providerId];

  if (!modelId) {
    throw new Error(`Default provider ${providerId} needs a saved model before Hermes can use it`);
  }

  const nativeProvider = HERMES_NATIVE_PROVIDER_MAP[providerId];
  if (nativeProvider) {
    return {
      provider: nativeProvider.provider,
      defaultModel: modelId,
      baseUrl: nativeProvider.baseUrl || savedBaseUrl || null,
    };
  }

  const resolvedBaseUrl = resolveHermesProviderBaseUrl(defaultProvider);

  if (!resolvedBaseUrl) {
    throw new Error(`Provider ${providerId} needs a base URL before Hermes can use it`);
  }

  const modelConfig = {
    provider: "custom",
    defaultModel: modelId,
    baseUrl: resolvedBaseUrl,
  };
  const apiKey = resolveHermesModelApiKey(defaultProvider, envVars);
  return apiKey ? { ...modelConfig, apiKey } : modelConfig;
}

function hasMeaningfulHermesModelConfig(modelConfig = {}) {
  return Boolean(
    String(modelConfig?.defaultModel || "").trim() ||
    String(modelConfig?.provider || "").trim() ||
    String(modelConfig?.baseUrl || "").trim(),
  );
}

// Managed auth and environment material

async function getIntegrationLlmEnvVars(agentId) {
  try {
    const { getIntegrationEnvVars } = require("./integrations");
    const integrationEnvVars = await getIntegrationEnvVars(agentId);
    const integrationLlmKeys = {};
    for (const [envVar, value] of Object.entries(integrationEnvVars)) {
      if (LLM_ENV_VARS.has(envVar)) {
        integrationLlmKeys[envVar] = value;
      }
    }
    return integrationLlmKeys;
  } catch {
    return {};
  }
}

/**
 * Build OpenClaw auth profiles by merging user provider keys with matching
 * per-agent integration tokens; explicit provider keys take precedence.
 *
 * @param {string} userId - User whose saved provider credentials should be loaded.
 * @param {string} agentId - Agent whose integration credentials should be considered.
 * @returns {Promise<Object>} OpenClaw auth-profile document.
 */
async function buildAuthProfilesForAgent(userId, agentId) {
  const llmKeys = await llmProviders.getProviderKeys(userId);
  const overrides =
    typeof llmProviders.getProviderEndpoints === "function"
      ? await llmProviders.getProviderEndpoints(userId)
      : { byEnvVar: {}, byProvider: {}, apiVersionByEnvVar: {}, apiVersionByProvider: {} };

  const integrationLlmKeys = await getIntegrationLlmEnvVars(agentId);
  // LLM provider keys win over integration-sourced tokens for the same env var
  return llmProviders.buildAuthProfiles(
    { ...integrationLlmKeys, ...llmKeys },
    overrides.byProvider || {},
    overrides.apiVersionByProvider || {},
  );
}

/**
 * Build a best-effort OpenClaw managed environment from currently available
 * provider, endpoint, integration, and model sources for pod recreation.
 *
 * @param {string} userId - User whose provider credentials should be loaded.
 * @param {string} agentId - Agent whose integration environment should be included.
 * @param {Object|null} [defaultProvider=null] - Saved default provider and model.
 * @returns {Promise<Object>} Filtered managed environment values.
 */
async function buildOpenClawManagedEnvForAgent(userId, agentId, defaultProvider = null) {
  const llmKeys = await llmProviders.getProviderKeys(userId);
  const overrides =
    typeof llmProviders.getProviderEndpoints === "function"
      ? await llmProviders.getProviderEndpoints(userId)
      : { byEnvVar: {}, apiVersionByEnvVar: {}, deploymentByEnvVar: {} };
  const baseUrlEnvVars =
    typeof llmProviders.buildBaseUrlEnvVars === "function"
      ? llmProviders.buildBaseUrlEnvVars(overrides.byEnvVar || {})
      : {};
  const apiVersionEnvVars =
    typeof llmProviders.buildApiVersionEnvVars === "function"
      ? llmProviders.buildApiVersionEnvVars(overrides.apiVersionByEnvVar || {})
      : {};
  const deploymentEnvVars =
    typeof llmProviders.buildDeploymentEnvVars === "function"
      ? llmProviders.buildDeploymentEnvVars(overrides.deploymentByEnvVar || {})
      : {};
  let integrationEnvVars = {};
  try {
    const { getIntegrationEnvVars } = require("./integrations");
    integrationEnvVars = await getIntegrationEnvVars(agentId);
  } catch {
    integrationEnvVars = {};
  }
  const fullModel = buildDefaultOpenClawModel(defaultProvider);

  return Object.fromEntries(
    Object.entries(
      buildCustomProviderEnv(
        {
          ...integrationEnvVars,
          ...llmKeys,
          ...baseUrlEnvVars,
          ...apiVersionEnvVars,
          ...deploymentEnvVars,
          ...(fullModel ? { NORA_DEFAULT_OPENCLAW_MODEL: fullModel } : {}),
        },
        defaultProvider,
      ),
    ).filter(([key, value]) => key && value != null && String(value) !== ""),
  );
}

/**
 * Build a best-effort Hermes managed environment from currently available
 * provider, endpoint, persisted-channel, and integration sources. Explicit
 * provider settings win when sources overlap.
 *
 * @param {string} userId - User whose provider credentials should be loaded.
 * @param {string} agentId - Agent whose channel and integration values should be included.
 * @returns {Promise<Object>} Filtered managed environment values.
 */
async function buildHermesManagedEnvForAgent(userId, agentId) {
  const llmKeys = await llmProviders.getProviderKeys(userId);
  const overrides =
    typeof llmProviders.getProviderEndpoints === "function"
      ? await llmProviders.getProviderEndpoints(userId)
      : { byEnvVar: {}, byProvider: {}, apiVersionByEnvVar: {}, apiVersionByProvider: {} };
  const baseUrlEnvVars =
    typeof llmProviders.buildBaseUrlEnvVars === "function"
      ? llmProviders.buildBaseUrlEnvVars(overrides.byEnvVar || {})
      : {};
  const apiVersionEnvVars =
    typeof llmProviders.buildApiVersionEnvVars === "function"
      ? llmProviders.buildApiVersionEnvVars(overrides.apiVersionByEnvVar || {})
      : {};

  // The managed .env block is replaced wholesale on every write, so persisted
  // channel env must ride along or an LLM key save silently drops every
  // configured Hermes channel.
  let channelEnvVars = {};
  try {
    const { buildHermesChannelEnvForAgent } = require("./hermesUi");
    channelEnvVars = await buildHermesChannelEnvForAgent(agentId);
  } catch {
    channelEnvVars = {};
  }

  try {
    const { getIntegrationEnvVars } = require("./integrations");
    const integrationEnvVars = await getIntegrationEnvVars(agentId);
    return Object.fromEntries(
      Object.entries({
        ...integrationEnvVars,
        ...channelEnvVars,
        ...llmKeys,
        ...baseUrlEnvVars,
        ...apiVersionEnvVars,
      }).filter(([key, value]) => key && value != null && String(value) !== ""),
    );
  } catch {
    return Object.fromEntries(
      Object.entries({
        ...channelEnvVars,
        ...llmKeys,
        ...baseUrlEnvVars,
        ...apiVersionEnvVars,
      }).filter(([key, value]) => key && value != null && String(value) !== ""),
    );
  }
}

// Runtime write command construction

function buildAuthProfilesWriteCommand(authProfiles) {
  return buildOpenClawAuthProfilesWriteCommand(authProfiles);
}

function buildDefaultModelCommand(defaultProvider = null) {
  const fullModel = buildDefaultOpenClawModel(defaultProvider);
  if (!fullModel) return null;

  return buildOpenClawDefaultModelCommand(fullModel);
}

function buildDefaultOpenClawModel(defaultProvider = null) {
  if (!defaultProvider) return null;

  const modelId = defaultProvider.model || PROVIDER_MODEL_DEFAULTS[defaultProvider.provider];
  if (!modelId) return null;

  return buildOpenClawModelForProvider(defaultProvider.provider, modelId);
}

function buildCustomProviderEnv(baseEnv = {}, defaultProvider = null) {
  const providerId = String(defaultProvider?.provider || "").trim();
  if (providerId !== "microsoft-foundry") return baseEnv;

  const fullModel = buildDefaultOpenClawModel(defaultProvider);
  const deployment = String(defaultProvider?.model || "").trim();
  return {
    ...baseEnv,
    ...(deployment ? { MICROSOFT_FOUNDRY_DEPLOYMENT: deployment } : {}),
    ...(fullModel ? { NORA_DEFAULT_OPENCLAW_MODEL: fullModel } : {}),
  };
}

function escapeDotenvValue(value) {
  return `"${String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"')}"`;
}

/**
 * Build a shell command that replaces Nora's managed Hermes environment block
 * while preserving unrelated `.env` content and enforcing private file modes.
 *
 * @param {Object} [envVars={}] - Environment values to write into the managed block.
 * @returns {string} Shell command for rewriting `/opt/data/.env`.
 */
function buildHermesEnvWriteCommand(envVars = {}) {
  const managedBlock = Object.entries(envVars)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${escapeDotenvValue(value)}`)
    .join("\n");
  const blockB64 = Buffer.from(managedBlock).toString("base64");

  return [
    "set -eu",
    'start_marker="# >>> NORA MANAGED ENV >>>"',
    'end_marker="# <<< NORA MANAGED ENV <<<"',
    'tmp_file="$(mktemp)"',
    "if [ -f /opt/data/.env ]; then",
    '  awk -v start="$start_marker" -v end="$end_marker" \'BEGIN{skip=0} $0==start {skip=1; next} $0==end {skip=0; next} !skip {print}\' /opt/data/.env > "$tmp_file"',
    "else",
    '  : > "$tmp_file"',
    "fi",
    'if [ -s "$tmp_file" ]; then printf \'\\n\' >> "$tmp_file"; fi',
    'printf \'%s\\n\' "$start_marker" >> "$tmp_file"',
    `printf '%s' ${shellSingleQuote(blockB64)} | base64 -d >> "$tmp_file"`,
    "printf '\\n' >> \"$tmp_file\"",
    'printf \'%s\\n\' "$end_marker" >> "$tmp_file"',
    'chown hermes:hermes "$tmp_file" 2>/dev/null || true',
    'chmod 0600 "$tmp_file"',
    'mv "$tmp_file" /opt/data/.env',
    "chown hermes:hermes /opt/data/.env 2>/dev/null || true",
    "chmod 0600 /opt/data/.env",
  ].join("\n");
}

// Runtime command execution and writes

/**
 * Execute an authenticated command through the runtime sidecar, rejecting HTTP
 * failures and non-zero command exits.
 *
 * @param {Object} agent - Agent whose runtime sidecar should execute the command.
 * @param {string} command - Shell command sent to the sidecar.
 * @param {Object} [options={}] - Runtime command timeout options.
 * @returns {Promise<Object>} Runtime execution response payload.
 */
async function runRuntimeCommand(agent, command, { timeout = 30000 } = {}) {
  const runtimeUrl = runtimeUrlForAgent(agent, "/exec");
  if (!runtimeUrl) {
    throw new Error("Agent runtime endpoint unavailable");
  }

  const response = await fetch(runtimeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await runtimeAuthHeaders(agent)) },
    body: JSON.stringify({
      command,
      timeout,
    }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || `Runtime command failed with HTTP ${response.status}`);
  }

  if ((payload.exitCode || 0) !== 0) {
    throw new Error(
      payload.stderr || payload.stdout || `Runtime command exited with code ${payload.exitCode}`,
    );
  }

  return payload;
}

/**
 * Execute a shell command through the agent's backend, collecting output and
 * preserving exit-code metadata on failures.
 *
 * @param {Object} agent - Agent whose container should execute the command.
 * @param {string} command - Shell command to run.
 * @param {Object} [options={}] - Stream collection timeout options.
 * @returns {Promise<Object>} Successful exit code and combined command output.
 */
async function runContainerCommand(agent, command, { timeout = 30000 } = {}) {
  const execResult = await containerManager.exec(agent, {
    cmd: ["/bin/sh", "-lc", command],
    tty: true,
    env: [],
  });
  if (!execResult?.exec || !execResult?.stream) {
    throw new Error("Container exec unavailable");
  }

  const output = await new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        execResult.stream.destroy();
      } catch {
        // Ignore stream teardown failures.
      }
      reject(new Error(`Container command timed out after ${timeout}ms`));
    }, timeout);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    execResult.stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    execResult.stream.on("end", finish);
    execResult.stream.on("close", finish);
    execResult.stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });

  const inspectResult = await execResult.exec.inspect();
  const exitCode = inspectResult?.ExitCode ?? 0;
  if (exitCode !== 0) {
    const error = new Error(output.trim() || `Container command exited with code ${exitCode}`);
    error.exitCode = exitCode;
    error.output = output;
    throw error;
  }

  return { exitCode, output };
}

/**
 * Write OpenClaw auth through the runtime sidecar, falling back to direct exec
 * only for Docker and Proxmox-backed agents.
 *
 * @param {Object} agent - Agent receiving the auth profiles.
 * @param {Object} authProfiles - OpenClaw auth-profile document to persist.
 * @returns {Promise<Object>} Runtime or container execution result.
 */
async function writeAuthToContainer(agent, authProfiles) {
  const command = buildAuthProfilesWriteCommand(authProfiles);
  try {
    return await runRuntimeCommand(agent, command);
  } catch (error) {
    const backendType = String(agent?.backend_type || "")
      .trim()
      .toLowerCase();
    if (!CONTAINER_EXEC_AUTH_FALLBACK_BACKENDS.has(backendType)) {
      throw error;
    }
    return runContainerCommand(agent, command);
  }
}

/**
 * Persist the Hermes managed environment through deployment env on Kubernetes
 * or a protected `.env` rewrite on other backends.
 *
 * @param {Object} agent - Hermes agent receiving the environment.
 * @param {Object} envVars - Complete managed environment values.
 * @returns {Promise} Backend-dependent update or command result.
 */
async function writeHermesEnvToContainer(agent, envVars) {
  if (
    typeof containerManager.isKubernetesAgent === "function" &&
    containerManager.isKubernetesAgent(agent)
  ) {
    return containerManager.updateEnv(agent, {
      ...envVars,
      ...buildHermesRuntimeBootstrapEnv({ envVars }),
    });
  }
  return runContainerCommand(agent, buildHermesEnvWriteCommand(envVars));
}

// Runtime restart and address reconciliation

function pickDockerComposeNetworkAddress(info = {}) {
  const networks = info?.NetworkSettings?.Networks || {};
  for (const [name, network] of Object.entries(networks)) {
    if (name.endsWith("_default") && network?.IPAddress) {
      return network.IPAddress;
    }
  }
  for (const [name, network] of Object.entries(networks)) {
    if (name !== "bridge" && network?.IPAddress) {
      return network.IPAddress;
    }
  }
  return info?.NetworkSettings?.IPAddress || "";
}

/**
 * Best-effort refresh of a Docker agent's in-memory and persisted runtime host
 * after a restart changes its Compose network address.
 *
 * @param {Object} agent - Restarted Docker agent to refresh.
 * @returns {Promise<string|null>} Updated address, or `null` when unavailable.
 */
async function refreshDockerRuntimeAddress(agent) {
  const backendType = String(agent?.backend_type || "")
    .trim()
    .toLowerCase();
  if (backendType !== "docker" || !agent?.container_id || !agent?.id) return null;

  try {
    const Docker = require("dockerode");
    const docker = new Docker({ socketPath: "/var/run/docker.sock" });
    const info = await docker.getContainer(agent.container_id).inspect();
    const host = pickDockerComposeNetworkAddress(info);
    if (!host) return null;

    agent.host = host;
    agent.runtime_host = host;
    await db.query("UPDATE agents SET host = $2, runtime_host = $2 WHERE id = $1", [
      agent.id,
      host,
    ]);
    return host;
  } catch (error) {
    console.warn(
      `[authSync] Failed to refresh Docker runtime host for agent ${agent.id}:`,
      error.message,
    );
    return null;
  }
}

async function restartAgentAndRefreshAddress(agent) {
  const result = await containerManager.restart(agent);
  await refreshDockerRuntimeAddress(agent);
  return result;
}

// Auth synchronization orchestration

/**
 * Rebuild runtime auth for a user's running or warning container-backed agents,
 * restart each backend, and isolate failures to per-agent result entries.
 *
 * @param {string} userId - Owner whose provider credentials and agents should be synced.
 * @param {string|null} [agentId=null] - Optional owner-scoped agent to sync exclusively.
 * @param {Object} [options={}] - `onlyIfAuthPresent` is a best-effort empty-auth skip;
 * OpenClaw's structural profile envelope may appear nonempty without credentials.
 * @returns {Promise<Array>} Per-agent `synced`, `skipped`, or `failed` results.
 */
async function syncAuthToUserAgents(userId, agentId = null, options = {}) {
  const onlyIfAuthPresent = Boolean(options?.onlyIfAuthPresent);
  const defaultRow = await db.query(
    "SELECT id, provider, model, config FROM llm_providers WHERE user_id = $1 AND is_default = true LIMIT 1",
    [userId],
  );
  const defaultProvider = defaultRow.rows[0] || null;
  const modelCommand = buildDefaultModelCommand(defaultProvider);
  let hermesModelConfig = null;
  let hasHermesModelConfig = false;

  const agentQuery = agentId
    ? `SELECT id, container_id, backend_type, runtime_family, deploy_target,
              execution_target_id,
              sandbox_profile, host, runtime_host, runtime_port,
              gateway_host_port, gateway_host, gateway_port
         FROM agents
        WHERE id = $1 AND user_id = $2 AND status IN ('running', 'warning') AND container_id IS NOT NULL`
    : `SELECT id, container_id, backend_type, runtime_family, deploy_target,
              execution_target_id,
              sandbox_profile, host, runtime_host, runtime_port,
              gateway_host_port, gateway_host, gateway_port
         FROM agents
        WHERE user_id = $1 AND status IN ('running', 'warning') AND container_id IS NOT NULL`;
  const agentParams = agentId ? [agentId, userId] : [userId];
  const agents = await db.query(agentQuery, agentParams);

  // Evict stale gateway connections — the restart will invalidate them
  let evictConnection;
  try {
    evictConnection = require("./gatewayProxy").evictConnection;
  } catch {
    /* gatewayProxy not available in worker context */
  }

  const results = [];
  for (const agent of agents.rows) {
    try {
      const runtimeFamily = resolveAgentRuntimeFamily(agent);
      // Evict the cached WS connection before restarting so the proxy
      // creates a fresh one on the next request instead of hitting the circuit breaker
      if (evictConnection) {
        evictConnection(agent);
      }
      if (runtimeFamily === "hermes") {
        let persistedModelConfig = null;
        try {
          const { getPersistedHermesState } = require("./hermesUi");
          const persistedState = await getPersistedHermesState(agent.id);
          if (hasMeaningfulHermesModelConfig(persistedState?.modelConfig)) {
            persistedModelConfig = persistedState.modelConfig;
          }
        } catch {
          persistedModelConfig = null;
        }

        const envVars = await buildHermesManagedEnvForAgent(userId, agent.id);
        if (!persistedModelConfig && !hasHermesModelConfig) {
          hermesModelConfig = buildHermesModelConfig(defaultProvider, envVars);
          hasHermesModelConfig = true;
        }
        const selectedHermesModelConfig = persistedModelConfig
          ? attachHermesCustomApiKey(persistedModelConfig, defaultProvider, envVars)
          : hermesModelConfig;
        if (
          onlyIfAuthPresent &&
          Object.keys(envVars).length === 0 &&
          !persistedModelConfig &&
          !hermesModelConfig
        ) {
          results.push({ agentId: agent.id, status: "skipped" });
          continue;
        }
        if (selectedHermesModelConfig) {
          const { persistHermesModelConfig } = require("./hermesUi");
          await persistHermesModelConfig(agent, selectedHermesModelConfig);
        }
        await writeHermesEnvToContainer(agent, envVars);
        await restartAgentAndRefreshAddress(agent);
        const readiness = await waitForAgentReadiness({
          host: agent.host,
          runtimeHost: agent.runtime_host,
          runtimePort: agent.runtime_port,
          gatewayHostPort: agent.gateway_host_port,
          gatewayHost: agent.gateway_host,
          gatewayPort: agent.gateway_port,
          checkGateway: false,
        });
        if (!readiness.ok) {
          throw new Error(
            `Agent runtime did not recover after env sync restart (${readiness.runtime?.error || "unreachable"})`,
          );
        }

        console.log(
          `[authSync] Synced Hermes env + model config to agent ${agent.id} (backend restarted)`,
        );
        results.push({ agentId: agent.id, status: "synced" });
        continue;
      }

      const authProfiles = await buildAuthProfilesForAgent(userId, agent.id);
      if (onlyIfAuthPresent && Object.keys(authProfiles).length === 0 && !modelCommand) {
        results.push({ agentId: agent.id, status: "skipped" });
        continue;
      }

      // Kubernetes: patch the Deployment env before any exec writes. The
      // exec-written files below only fix the CURRENT pod; the rollout the
      // restart triggers replaces it with a pod that re-seeds auth from env,
      // and the same applies to evictions and node scale events later on.
      if (
        typeof containerManager.isKubernetesAgent === "function" &&
        containerManager.isKubernetesAgent(agent) &&
        typeof containerManager.updateEnv === "function"
      ) {
        const managedEnv = await buildOpenClawManagedEnvForAgent(userId, agent.id, defaultProvider);
        if (Object.keys(managedEnv).length > 0) {
          await containerManager.updateEnv(agent, managedEnv);
        }
      }

      await writeAuthToContainer(agent, authProfiles);

      // Merge custom-provider registrations (Foundry → azure-openai-responses)
      // into openclaw.json before restart so `<provider>/<deployment>` model
      // strings resolve instead of throwing "Unknown model".
      const llmKeysForCustom = await llmProviders.getProviderKeys(userId);
      const endpointOverrides =
        typeof llmProviders.getProviderEndpoints === "function"
          ? await llmProviders.getProviderEndpoints(userId)
          : { byEnvVar: {} };
      // byEnvVar is keyed by API_KEY env var; transform to {PROVIDER}_BASE_URL.
      const baseUrlEnvVars =
        typeof llmProviders.buildBaseUrlEnvVars === "function"
          ? llmProviders.buildBaseUrlEnvVars(endpointOverrides.byEnvVar || {})
          : {};
      // Carry the deployment too so the re-merged Foundry model registry keeps
      // the configured deployment (e.g. gpt-5.5-1) and doesn't revert to the
      // hardcoded fallback, which would resurface "Unknown model".
      const deploymentEnvVars =
        typeof llmProviders.buildDeploymentEnvVars === "function"
          ? llmProviders.buildDeploymentEnvVars(endpointOverrides.deploymentByEnvVar || {})
          : {};
      const customProviderEnv = buildCustomProviderEnv(
        { ...llmKeysForCustom, ...baseUrlEnvVars, ...deploymentEnvVars },
        defaultProvider,
      );
      const customProviders = buildOpenClawCustomProviders(customProviderEnv);
      if (Object.keys(customProviders).length > 0) {
        const providerMergeCommand = buildOpenClawConfigMergeCommand({
          models: { providers: customProviders },
        });
        try {
          await runRuntimeCommand(agent, providerMergeCommand);
        } catch (error) {
          if (
            !CONTAINER_EXEC_AUTH_FALLBACK_BACKENDS.has(
              String(agent?.backend_type || "")
                .trim()
                .toLowerCase(),
            )
          ) {
            throw error;
          }
          await runContainerCommand(agent, providerMergeCommand);
        }
      }

      await restartAgentAndRefreshAddress(agent);

      const readiness = await waitForAgentReadiness({
        host: agent.host,
        runtimeHost: agent.runtime_host,
        runtimePort: agent.runtime_port,
        gatewayHostPort: agent.gateway_host_port,
        gatewayHost: agent.gateway_host,
        gatewayPort: agent.gateway_port,
      });
      if (!readiness.ok) {
        throw new Error(
          `Agent runtime did not recover after auth sync restart (${readiness.runtime?.error || readiness.gateway?.error || "unreachable"})`,
        );
      }

      if (modelCommand) {
        await runRuntimeCommand(agent, modelCommand, { timeout: 60000 });
      }

      console.log(`[authSync] Synced OpenClaw auth to agent ${agent.id} (backend restarted)`);
      results.push({ agentId: agent.id, status: "synced" });
    } catch (e) {
      console.warn(`[authSync] Failed for agent ${agent.id}:`, e.message);
      results.push({ agentId: agent.id, status: "failed", error: e.message });
    }
  }
  return results;
}

module.exports = {
  syncAuthToUserAgents,
  buildAuthProfilesForAgent,
  buildAuthProfilesWriteCommand,
  buildDefaultModelCommand,
  buildOpenClawManagedEnvForAgent,
  buildHermesModelConfig,
  buildHermesEnvWriteCommand,
  buildHermesManagedEnvForAgent,
  runRuntimeCommand,
  runContainerCommand,
  writeAuthToContainer,
  writeHermesEnvToContainer,
};
