// @ts-nocheck
// Syncs OpenClaw auth to running agents via the runtime sidecar.
// Writes the legacy auth-profiles.json file, imports API-key profiles into
// OpenClaw's per-agent SQLite auth store, then restarts the backend so the
// gateway process re-reads auth on startup (it does not hot-reload from disk).
// Called whenever LLM provider keys or LLM-relevant integrations change.

const db = require("./db");
const containerManager = require("./containerManager");
const llmProviders = require("./llmProviders");
const mcpServers = require("./mcpServers");
const { runtimeUrlForAgent } = require("../agent-runtime/lib/agentEndpoints");
const { runtimeAuthHeaders } = require("./runtimeAuth");
const { waitForAgentReadiness } = require("./healthChecks");
const { resolveAgentRuntimeFamily } = require("./agentRuntimeFields");
const {
  assertRemoteHostAgentUse,
  isRemoteDockerAgent,
  toPublicRemoteHostAuthorizationError,
} = require("./remoteHosts");
const { shellSingleQuote } = require("../agent-runtime/lib/containerCommand");
const {
  buildOpenClawAuthProfilesWriteCommand,
  buildOpenClawCustomProviders,
  buildOpenClawDefaultModelCommand,
  buildOpenClawManagedMcpServersCommand,
  buildOpenClawManagedProviderStateCommand,
  buildOpenClawModelForProvider,
  encodeOpenClawManagedMcpServers,
  mapNoraProviderIdToOpenClaw,
  OPENCLAW_MANAGED_MCP_SERVERS_ENV,
} = require("../agent-runtime/lib/runtimeBootstrap");
const {
  HERMES_MODEL_CONFIG_ENV,
  buildHermesRuntimeBootstrapEnv,
} = require("../agent-runtime/lib/hermesRuntimeBootstrap");
const { NEMOCLAW_DEFAULT_MODEL } = require("../agent-runtime/lib/nemoclawDefaults");

const providerCatalog = Array.isArray(llmProviders.PROVIDERS)
  ? llmProviders.PROVIDERS
  : typeof llmProviders.getAvailableProviders === "function"
    ? llmProviders.getAvailableProviders()
    : [];
const providerCatalogById = new Map(providerCatalog.map((provider) => [provider.id, provider]));
const LLM_ENV_VARS = new Set(providerCatalog.map((provider) => provider.envVar).filter(Boolean));
const MANAGED_OPENCLAW_AUTH_PROFILE_IDS = [
  ...new Set(
    providerCatalog
      .map((provider) => mapNoraProviderIdToOpenClaw(provider.id))
      .filter(Boolean)
      .map((providerId) => `${providerId}:default`),
  ),
];
const MANAGED_OPENCLAW_MODEL_PROVIDER_IDS = [
  ...new Set(
    providerCatalog.map((provider) => mapNoraProviderIdToOpenClaw(provider.id)).filter(Boolean),
  ),
];

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
const PROVIDER_AUTH_QUARANTINE_REASON = "provider_auth_reconciliation_failed";
const PROVIDER_AUTH_PENDING_REASON = "provider_auth_reconciliation_pending";
const REMOTE_HOST_AUTH_RECHECK_MS = Math.max(
  250,
  Number.parseInt(process.env.REMOTE_HOST_AUTH_RECHECK_MS || "1000", 10) || 1000,
);
const CONTAINER_EXEC_TERMINATION_GRACE_MS = 5000;

function isProviderAuthStatusHoldReason(value) {
  return value === PROVIDER_AUTH_PENDING_REASON || value === PROVIDER_AUTH_QUARANTINE_REASON;
}

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

  const sanitized = { ...modelConfig };
  delete sanitized.apiKey;
  delete sanitized.api_key;
  const apiKey = resolveHermesModelApiKey(defaultProvider, envVars);
  if (!apiKey) return sanitized;

  const defaultBaseUrl = resolveHermesProviderBaseUrl(defaultProvider);
  const modelBaseUrl = String(modelConfig.baseUrl || "").trim();
  if (
    modelBaseUrl &&
    defaultBaseUrl &&
    normalizeUrlForCompare(modelBaseUrl) !== normalizeUrlForCompare(defaultBaseUrl)
  ) {
    return sanitized;
  }

  return { ...sanitized, apiKey };
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
 * Build auth-profiles.json content for a specific agent.
 * Merges per-user LLM provider keys with per-agent integration tokens
 * that overlap with LLM auth env vars (e.g., HF_TOKEN, OPENAI_API_KEY).
 * Explicit LLM provider keys always take precedence over integration tokens.
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
 * Env vars the OpenClaw boot script needs to rebuild auth from scratch.
 * On Kubernetes a restart is a rollout: the replacement pod gets a fresh
 * filesystem and re-seeds auth-profiles.json + the SQLite auth store from
 * the pod env alone, so exec-written files never survive it. Keys saved
 * after provisioning must therefore be patched onto the Deployment env.
 * Carries ALL integration env vars (not just LLM-overlapping ones) — a
 * GITHUB_TOKEN/SLACK_TOKEN connected after provisioning otherwise lives
 * only in the pod's openclaw.json and dies with the pod.
 */
async function getEnabledMcpRuntimeState(agentId) {
  if (typeof mcpServers.getEnabledMcpRuntimeState !== "function") {
    return {
      enabledIds: [],
      entries: [],
      desiredServers: {},
      env: {},
      managedEnvNames: [],
    };
  }
  return mcpServers.getEnabledMcpRuntimeState(agentId);
}

async function buildOpenClawManagedEnvForAgent(
  userId,
  agentId,
  defaultProvider = null,
  { mcpRuntimeState = null } = {},
) {
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
  const resolvedMcpRuntimeState = mcpRuntimeState || (await getEnabledMcpRuntimeState(agentId));
  const fullModel = buildDefaultOpenClawModel(defaultProvider);

  return Object.fromEntries(
    Object.entries(
      buildCustomProviderEnv(
        {
          ...integrationEnvVars,
          ...(resolvedMcpRuntimeState.env || {}),
          [OPENCLAW_MANAGED_MCP_SERVERS_ENV]: encodeOpenClawManagedMcpServers(
            resolvedMcpRuntimeState.desiredServers || {},
          ),
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

function buildAuthProfilesWriteCommand(authProfiles) {
  return buildOpenClawAuthProfilesWriteCommand(authProfiles, {
    managedProfileIds: MANAGED_OPENCLAW_AUTH_PROFILE_IDS,
  });
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

function createRuntimeCommandExitUnconfirmedError(exitCode) {
  const error = new Error(
    `Runtime command response did not include an integer exit code (received ${String(exitCode)})`,
  );
  error.code = "RUNTIME_COMMAND_EXIT_UNCONFIRMED";
  return error;
}

async function runRuntimeCommand(agent, command, { timeout = 30000 } = {}) {
  const runtimeUrl = runtimeUrlForAgent(agent, "/exec");
  if (!runtimeUrl) {
    throw new Error("Agent runtime endpoint unavailable");
  }
  const remoteDocker = isRemoteDockerAgent(agent);
  const authorizeRemoteUse = async () => {
    if (!remoteDocker) return;
    try {
      await assertRemoteHostAgentUse(agent, { includeProfile: false });
    } catch (error) {
      throw toPublicRemoteHostAuthorizationError(error);
    }
  };

  const controller = new AbortController();
  let authorizationTimer = null;
  let authorizationInFlight = null;
  let authorizationError = null;
  let requestSettled = false;

  if (remoteDocker) {
    const checkAuthorization = () => {
      if (requestSettled || authorizationInFlight || authorizationError) {
        return authorizationInFlight;
      }
      authorizationInFlight = Promise.resolve()
        .then(() => authorizeRemoteUse())
        .catch((error) => {
          authorizationError = error;
          if (!requestSettled) controller.abort(authorizationError);
        })
        .finally(() => {
          authorizationInFlight = null;
        });
      return authorizationInFlight;
    };
    authorizationTimer = setInterval(() => {
      void checkAuthorization();
    }, REMOTE_HOST_AUTH_RECHECK_MS);
    authorizationTimer.unref?.();
  }

  try {
    let response;
    try {
      response = await fetch(runtimeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await runtimeAuthHeaders(agent)) },
        body: JSON.stringify({
          command,
          timeout,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (authorizationError) throw authorizationError;
      throw error;
    }
    if (authorizationError) throw authorizationError;

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    // Stop scheduling new checks, wait for one that raced the response, and
    // perform a final positive-grant check before accepting the mutation.
    requestSettled = true;
    if (authorizationTimer) clearInterval(authorizationTimer);
    const pendingAuthorization = authorizationInFlight;
    if (pendingAuthorization) await pendingAuthorization;
    if (authorizationError) throw authorizationError;
    await authorizeRemoteUse();

    if (!response.ok) {
      throw new Error(payload.error || `Runtime command failed with HTTP ${response.status}`);
    }

    if (!Number.isInteger(payload.exitCode)) {
      throw createRuntimeCommandExitUnconfirmedError(payload.exitCode);
    }

    if (payload.exitCode !== 0) {
      throw new Error(
        payload.stderr || payload.stdout || `Runtime command exited with code ${payload.exitCode}`,
      );
    }

    return payload;
  } finally {
    requestSettled = true;
    if (authorizationTimer) clearInterval(authorizationTimer);
  }
}

function createContainerCommandExitUnconfirmedError(message) {
  const error = new Error(message);
  error.code = "CONTAINER_COMMAND_EXIT_UNCONFIRMED";
  return error;
}

function buildContainerCommandTerminationUnconfirmedError(originalError, cleanupError) {
  const error = new Error("Container command termination could not be confirmed", {
    cause: originalError,
  });
  error.code = "CONTAINER_COMMAND_TERMINATION_UNCONFIRMED";
  error.cleanupError = cleanupError;
  return error;
}

async function stopRemoteHermesAfterContainerCommandFailure(agent) {
  await containerManager.stop(agent);
  if (agent?.id) {
    await db.query("UPDATE agents SET status = 'stopped' WHERE id = $1", [agent.id]);
  }
}

async function runContainerCommand(agent, command, { timeout = 30000 } = {}) {
  // Remote Docker direct exec cannot safely kill only one command after an SSH
  // attach loss. Route it through the runtime sidecar instead: revocation
  // aborts the HTTP request and execEndpoint terminates and verifies that
  // command's process group without stopping the surrounding agent container.
  const remoteDocker = isRemoteDockerAgent(agent);
  const remoteHermes = remoteDocker && resolveAgentRuntimeFamily(agent) === "hermes";
  if (remoteDocker && !remoteHermes) {
    const payload = await runRuntimeCommand(agent, command, { timeout });
    const output =
      typeof payload?.output === "string"
        ? payload.output
        : [payload?.stdout, payload?.stderr].filter(Boolean).join("\n");
    return {
      ...payload,
      exitCode: payload.exitCode,
      output,
    };
  }

  const timeoutSeconds = Math.max(1, Math.ceil(timeout / 1000));
  const authorize = async () => {
    if (!remoteHermes) return;
    try {
      await assertRemoteHostAgentUse(agent, { includeProfile: false });
    } catch (error) {
      throw toPublicRemoteHostAuthorizationError(error);
    }
  };

  // Remote Hermes has no agent-runtime /exec endpoint. Keep its direct Docker
  // exec path, but establish the grant before starting and monitor it for the
  // full command lifetime. If that path becomes unconfirmable, stopping the
  // container is the only available way to guarantee the command cannot keep
  // running after revocation.
  await authorize();

  const trackedCommand = [
    "set -eu",
    'setsid_path="$(command -v setsid 2>/dev/null || true)"',
    'timeout_path="$(command -v timeout 2>/dev/null || true)"',
    '[ -n "$setsid_path" ] && [ -n "$timeout_path" ] || { echo "setsid and timeout are required for bounded container commands" >&2; exit 125; }',
    `exec "$setsid_path" "$timeout_path" --signal=TERM --kill-after=2s ${timeoutSeconds}s /bin/sh -lc "$1"`,
  ].join("\n");
  const execResult = await containerManager.exec(agent, {
    cmd: ["/bin/sh", "-lc", trackedCommand, "nora-bounded-command", command],
    tty: false,
    env: [],
  });
  if (!execResult?.exec || !execResult?.stream) {
    throw new Error("Container exec unavailable");
  }

  const { output, inspectResult } = await new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let streamBoundaryCheckPromise = null;
    let authorizationTimer = null;
    let authorizationInFlight = null;
    let authorizationError = null;
    let cleanupPromise = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (authorizationTimer) {
        clearInterval(authorizationTimer);
        authorizationTimer = null;
      }
    };

    const stopRemoteHermes = () => {
      if (!cleanupPromise) {
        cleanupPromise = stopRemoteHermesAfterContainerCommandFailure(agent);
      }
      return cleanupPromise;
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        execResult.stream.destroy();
      } catch {
        // The in-container timeout remains the bounded cleanup backstop.
      }
      if (!remoteHermes) {
        reject(error);
        return;
      }
      void stopRemoteHermes().then(
        () => reject(error),
        (cleanupError) =>
          reject(buildContainerCommandTerminationUnconfirmedError(error, cleanupError)),
      );
    };

    const checkAuthorization = () => {
      if (!remoteHermes || settled || authorizationInFlight || authorizationError) {
        return authorizationInFlight;
      }
      authorizationInFlight = Promise.resolve()
        .then(() => authorize())
        .catch((error) => {
          authorizationError = error;
          fail(error);
        })
        .finally(() => {
          authorizationInFlight = null;
        });
      return authorizationInFlight;
    };

    const timer = setTimeout(() => {
      fail(
        createContainerCommandExitUnconfirmedError(
          `Container command termination could not be confirmed after ${timeout}ms`,
        ),
      );
    }, timeout + CONTAINER_EXEC_TERMINATION_GRACE_MS);

    const finish = (status) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        output: Buffer.concat(chunks).toString("utf8"),
        inspectResult: status,
      });
    };

    const finishFromStreamBoundary = () => {
      if (settled || streamBoundaryCheckPromise) return;
      streamBoundaryCheckPromise = (async () => {
        try {
          if (authorizationTimer) {
            clearInterval(authorizationTimer);
            authorizationTimer = null;
          }
          const pendingAuthorization = authorizationInFlight;
          if (pendingAuthorization) await pendingAuthorization;
          if (authorizationError || settled) return;

          // A stream end/close alone can mean only that the Docker attach
          // transport was lost while the bounded command kept running.
          await authorize();
          const status = await execResult.exec.inspect();
          if (!status || status.Running !== false || status.ExitCode == null) {
            fail(
              createContainerCommandExitUnconfirmedError(
                "Container command stream ended before process exit was confirmed",
              ),
            );
            return;
          }
          await authorize();
          finish(status);
        } catch (error) {
          fail(error);
        } finally {
          streamBoundaryCheckPromise = null;
        }
      })();
    };

    execResult.stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    execResult.stream.on("end", finishFromStreamBoundary);
    execResult.stream.on("close", finishFromStreamBoundary);
    execResult.stream.on("error", (error) => {
      fail(error);
    });

    if (remoteHermes) {
      authorizationTimer = setInterval(() => {
        void checkAuthorization();
      }, REMOTE_HOST_AUTH_RECHECK_MS);
      authorizationTimer.unref?.();
    }
  });

  const exitCode = inspectResult.ExitCode;
  if (exitCode !== 0) {
    const error = new Error(output.trim() || `Container command exited with code ${exitCode}`);
    error.exitCode = exitCode;
    error.output = output;
    throw error;
  }

  return { exitCode, output };
}

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

async function writeHermesEnvToContainer(agent, envVars, modelConfig = undefined) {
  if (
    typeof containerManager.isKubernetesAgent === "function" &&
    containerManager.isKubernetesAgent(agent)
  ) {
    const managedEnvNames = llmProviders.getManagedProviderEnvNames({ runtimeFamily: "hermes" });
    // Channel-only writes intentionally omit modelConfig. Preserve the current
    // Deployment model bootstrap in that case; provider synchronization passes
    // either an object or null explicitly so it can replace or revoke it.
    const replacementNames =
      modelConfig === undefined
        ? managedEnvNames.filter((name) => name !== HERMES_MODEL_CONFIG_ENV)
        : managedEnvNames;
    return containerManager.updateEnv(
      agent,
      {
        ...envVars,
        ...buildHermesRuntimeBootstrapEnv({ envVars, modelConfig }),
      },
      {
        managedEnvNames: replacementNames,
      },
    );
  }
  return runContainerCommand(agent, buildHermesEnvWriteCommand(envVars));
}

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
  await containerManager.persistLifecycleRuntimeAddress(db, agent, result);
  await refreshDockerRuntimeAddress(agent);
  return result;
}

async function reconcileManagedRuntimeEnv(
  agent,
  envVars,
  runtimeFamily,
  { extraManagedEnvNames = [] } = {},
) {
  const managedEnvNames = [
    ...new Set([
      ...llmProviders.getManagedProviderEnvNames({ runtimeFamily }),
      ...(Array.isArray(extraManagedEnvNames) ? extraManagedEnvNames : []),
    ]),
  ];
  const backendType = String(agent?.backend_type || "")
    .trim()
    .toLowerCase();
  if (typeof containerManager.updateEnv !== "function") {
    throw new Error(
      `Backend ${backendType || "unknown"} cannot replace managed provider environment state`,
    );
  }
  await containerManager.updateEnv(agent, envVars, {
    managedEnvNames,
    // The builders above return Nora's complete current managed state for the
    // runtime. Mutable adapters may use this stronger contract to remove names
    // that disappeared from both the provider catalog and persisted
    // integrations, while K8s/Proxmox still use the explicit name universe.
    replaceManagedState: true,
  });
}

async function stageProviderAuthForStoppedAgent(userId, agent, options = {}) {
  if (options?.providerLockHeld !== true) {
    if (typeof llmProviders.withProviderStateLock !== "function") {
      throw new Error("Provider state locking is unavailable");
    }
    return llmProviders.withProviderStateLock(userId, () =>
      stageProviderAuthForStoppedAgent(userId, agent, {
        ...options,
        providerLockHeld: true,
      }),
    );
  }

  const backendType = String(agent?.backend_type || agent?.deploy_target || "")
    .trim()
    .toLowerCase();
  const hasRuntimeIdentity =
    Boolean(agent?.container_id || agent?.container_name) || backendType === "k8s";
  if (!agent?.id || !hasRuntimeIdentity) {
    throw new Error("Agent runtime is unavailable for provider authentication staging");
  }
  if (typeof containerManager.status !== "function") {
    throw new Error("Backend runtime status checks are unavailable");
  }

  const live = await containerManager.status(agent);
  if (live?.running) {
    throw new Error("Agent runtime must be stopped before provider authentication staging");
  }

  await assertRemoteHostAgentUse(agent, { includeProfile: false });
  const defaultRow = await db.query(
    "SELECT id, provider, model, config FROM llm_providers WHERE user_id = $1 AND is_default = true LIMIT 1",
    [userId],
  );
  const defaultProvider = defaultRow.rows[0] || null;
  const runtimeFamily = resolveAgentRuntimeFamily(agent);

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
    const generatedModelConfig = buildHermesModelConfig(defaultProvider, envVars);
    const selectedModelConfig = defaultProvider
      ? persistedModelConfig
        ? attachHermesCustomApiKey(persistedModelConfig, defaultProvider, envVars)
        : generatedModelConfig
      : null;
    await reconcileManagedRuntimeEnv(
      agent,
      {
        ...envVars,
        ...buildHermesRuntimeBootstrapEnv({
          envVars,
          modelConfig: selectedModelConfig,
        }),
      },
      "hermes",
      { extraManagedEnvNames: options.extraManagedEnvNames || [] },
    );
    return { runtimeFamily, defaultProvider, modelConfig: selectedModelConfig };
  }

  const mcpRuntimeState = await getEnabledMcpRuntimeState(agent.id);
  const managedEnv = await buildOpenClawManagedEnvForAgent(userId, agent.id, defaultProvider, {
    mcpRuntimeState,
  });
  await reconcileManagedRuntimeEnv(agent, managedEnv, "openclaw", {
    extraManagedEnvNames: [
      ...(options.extraManagedEnvNames || []),
      ...(mcpRuntimeState.managedEnvNames || []),
      OPENCLAW_MANAGED_MCP_SERVERS_ENV,
    ],
  });
  return { runtimeFamily, defaultProvider };
}

async function stopAgentAfterAuthSyncFailure(agent) {
  let quarantinePersisted = false;
  let quarantineError = null;
  try {
    await db.query("UPDATE agents SET status = 'error', paused_reason = $2 WHERE id = $1", [
      agent.id,
      PROVIDER_AUTH_QUARANTINE_REASON,
    ]);
    quarantinePersisted = true;
  } catch (error) {
    quarantineError = error;
  }

  let runtimeStopped = false;
  let stopError = null;
  try {
    await containerManager.stop(agent);
    runtimeStopped = true;
  } catch (error) {
    const ignorable =
      typeof containerManager.isIgnorableStopError === "function" &&
      containerManager.isIgnorableStopError(error);
    if (ignorable) runtimeStopped = true;
    else stopError = error;
  }

  let statusPersisted = false;
  if (runtimeStopped) {
    try {
      await db.query("UPDATE agents SET status = 'stopped', paused_reason = $2 WHERE id = $1", [
        agent.id,
        PROVIDER_AUTH_QUARANTINE_REASON,
      ]);
      statusPersisted = true;
    } catch (error) {
      stopError = stopError || error;
    }
  }
  return { runtimeStopped, statusPersisted, quarantinePersisted, quarantineError, stopError };
}

async function clearProviderAuthQuarantine(agentId) {
  await db.query("UPDATE agents SET paused_reason = NULL WHERE id = $1 AND paused_reason = $2", [
    agentId,
    PROVIDER_AUTH_QUARANTINE_REASON,
  ]);
}

function createProviderAuthLifecycleError(agent, cause = null) {
  const error = new Error(
    `Current provider authentication could not be reconciled for agent ${agent.id}`,
  );
  error.statusCode = 502;
  error.code = "AGENT_AUTH_RECONCILIATION_FAILED";
  if (cause) error.cause = cause;
  return error;
}

async function markProviderAuthPending(agent, action) {
  const pendingStatus = action === "start" ? "stopped" : "error";
  const updated = await db.query(
    `UPDATE agents
        SET status = $2,
            paused_reason = $3
      WHERE id = $1
      RETURNING *`,
    [agent.id, pendingStatus, PROVIDER_AUTH_PENDING_REASON],
  );
  if (!updated.rows[0]) {
    const error = new Error(`Agent ${agent.id} no longer exists`);
    error.statusCode = 404;
    error.code = "AGENT_NOT_FOUND";
    throw error;
  }
  Object.assign(agent, updated.rows[0]);
  return agent;
}

async function publishProviderAuthReady(agent) {
  const updated = await db.query(
    `UPDATE agents
        SET status = 'running',
            paused_reason = NULL
      WHERE id = $1
        AND paused_reason = $2
      RETURNING *`,
    [agent.id, PROVIDER_AUTH_PENDING_REASON],
  );
  if (!updated.rows[0]) {
    const error = new Error(
      `Agent ${agent.id} provider authentication state changed before lifecycle completion`,
    );
    error.code = "AGENT_AUTH_STATE_CHANGED";
    throw error;
  }
  Object.assign(agent, updated.rows[0]);
  return updated.rows[0];
}

async function resumeAgentWithProviderAuth(agent, action, options = {}) {
  if (!agent?.id || !agent?.user_id) {
    throw new Error("Agent id and durable owner are required for lifecycle reconciliation");
  }
  if (!new Set(["start", "restart"]).has(action)) {
    throw new Error(`Unsupported provider-auth lifecycle action: ${action}`);
  }
  if (options?.providerLockHeld !== true) {
    if (typeof llmProviders.withProviderStateLock !== "function") {
      throw new Error("Provider state locking is unavailable");
    }
    return llmProviders.withProviderStateLock(agent.user_id, () =>
      resumeAgentWithProviderAuth(agent, action, {
        ...options,
        providerLockHeld: true,
      }),
    );
  }

  await markProviderAuthPending(agent, action);
  let lifecycleResult = null;
  let syncFailureContained = false;
  let phase = action === "start" ? "offline_stage" : "auth_sync";

  try {
    if (action === "start") {
      await stageProviderAuthForStoppedAgent(agent.user_id, agent, {
        providerLockHeld: true,
      });
      phase = "physical_start";
      lifecycleResult = await containerManager.start(agent);
      await containerManager.persistLifecycleRuntimeAddress(db, agent, lifecycleResult);
      phase = "auth_sync";
    }

    const results = await syncAuthToUserAgents(agent.user_id, agent.id, {
      onlyIfAuthPresent: false,
      providerLockHeld: true,
      includeProviderAuthPending: true,
      startupStateStaged: action === "start",
    });
    const result = Array.isArray(results)
      ? results.find((entry) => entry?.agentId === agent.id)
      : null;
    if (result?.status !== "synced") {
      syncFailureContained = Boolean(
        result?.runtimeStopped && result?.statusPersisted && result?.quarantinePersisted,
      );
      throw createProviderAuthLifecycleError(agent, result?.error || result?.status || null);
    }

    phase = "final_status";
    const updatedAgent = await publishProviderAuthReady(agent);
    return { agent: updatedAgent, lifecycleResult, syncResult: result };
  } catch (candidate) {
    const error =
      candidate?.code === "AGENT_AUTH_RECONCILIATION_FAILED"
        ? candidate
        : phase === "physical_start"
          ? candidate
          : createProviderAuthLifecycleError(agent, candidate);
    if (!syncFailureContained) {
      const stopped = await stopAgentAfterAuthSyncFailure(agent);
      if (stopped.stopError || stopped.quarantineError || !stopped.statusPersisted) {
        error.statusCode = 500;
        error.cleanupError = stopped.stopError || stopped.quarantineError || null;
        error.message = `Current provider authentication could not be reconciled and agent ${agent.id} could not be quarantined automatically`;
      }
    }
    throw error;
  }
}

/**
 * Sync OpenClaw auth to all running agents of a user.
 * If agentId is provided, syncs only that agent.
 *
 * Returns an array of { agentId, status, error? } results.
 * Non-blocking safe: failures per-agent are logged but do not throw.
 */
async function syncAuthToUserAgents(userId, agentId = null, options = {}) {
  if (options?.providerLockHeld !== true) {
    if (typeof llmProviders.withProviderStateLock !== "function") {
      throw new Error("Provider state locking is unavailable");
    }
    return llmProviders.withProviderStateLock(userId, () =>
      syncAuthToUserAgents(userId, agentId, {
        ...options,
        providerLockHeld: true,
      }),
    );
  }

  const onlyIfAuthPresent = Boolean(options?.onlyIfAuthPresent);
  const includeProviderAuthPending = Boolean(options?.includeProviderAuthPending && agentId);
  const startupStateStaged = Boolean(options?.startupStateStaged && agentId);
  const extraManagedEnvNames = Array.isArray(options?.extraManagedEnvNames)
    ? options.extraManagedEnvNames
    : [];
  const defaultRow = await db.query(
    "SELECT id, provider, model, config FROM llm_providers WHERE user_id = $1 AND is_default = true LIMIT 1",
    [userId],
  );
  const defaultProvider = defaultRow.rows[0] || null;
  const modelCommand = buildDefaultModelCommand(defaultProvider);
  let hermesModelConfig = null;
  let hasHermesModelConfig = false;

  const agentQuery = agentId
    ? `SELECT id, user_id, name, container_id, container_name, backend_type, runtime_family, deploy_target,
              execution_target_id,
              sandbox_profile, host, runtime_host, runtime_port,
              gateway_host_port, gateway_host, gateway_port, gateway_token,
              status, paused_reason
         FROM agents
        WHERE id = $1
          AND user_id = $2
          AND (
            container_id IS NOT NULL
            OR container_name IS NOT NULL
            OR backend_type = 'k8s'
            OR deploy_target = 'k8s'
          )
          AND (
            status IN ('running', 'warning', 'stopped')
            OR (
              status = 'error'
              AND container_id IS NOT NULL
            )
            OR ($3::boolean = true AND paused_reason = $4)
          )`
    : `SELECT id, user_id, name, container_id, container_name, backend_type, runtime_family, deploy_target,
              execution_target_id,
              sandbox_profile, host, runtime_host, runtime_port,
              gateway_host_port, gateway_host, gateway_port, gateway_token,
              status, paused_reason
         FROM agents
        WHERE user_id = $1
          AND (
            status IN ('running', 'warning', 'stopped')
            OR (
              status = 'error'
              AND container_id IS NOT NULL
            )
          )
          AND (
            container_id IS NOT NULL
            OR container_name IS NOT NULL
            OR backend_type = 'k8s'
            OR deploy_target = 'k8s'
          )`;
  const agentParams = agentId
    ? [agentId, userId, includeProviderAuthPending, PROVIDER_AUTH_PENDING_REASON]
    : [userId];
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
      // Fail closed before the first runtime mutation. Adapter-level guards are
      // still required, but this prevents even an attempted managed-env write
      // after a Remote Docker grant has been revoked.
      await assertRemoteHostAgentUse(agent, { includeProfile: false });
      // Evict the cached WS connection before restarting so the proxy
      // creates a fresh one on the next request instead of hitting the circuit breaker
      if (evictConnection) {
        evictConnection(agent);
      }
      if (startupStateStaged) {
        if (agent.paused_reason !== PROVIDER_AUTH_PENDING_REASON) {
          throw new Error("Offline provider authentication staging is no longer pending");
        }
        await refreshDockerRuntimeAddress(agent);
        const readiness = await waitForAgentReadiness(
          {
            host: agent.host,
            runtimeHost: agent.runtime_host,
            runtimePort: agent.runtime_port,
            gatewayHostPort: agent.gateway_host_port,
            gatewayHost: agent.gateway_host,
            gatewayPort: agent.gateway_port,
            checkGateway: runtimeFamily !== "hermes",
          },
          {
            beforeAttempt: () => assertRemoteHostAgentUse(agent, { includeProfile: false }),
          },
        );
        if (!readiness.ok) {
          throw new Error(
            `Agent runtime did not recover after staged provider auth start (${readiness.runtime?.error || readiness.gateway?.error || "unreachable"})`,
          );
        }
        results.push({ agentId: agent.id, status: "synced" });
        continue;
      }
      if (agent.status === "stopped") {
        await stageProviderAuthForStoppedAgent(userId, agent, {
          providerLockHeld: true,
          extraManagedEnvNames,
        });
        await clearProviderAuthQuarantine(agent.id);
        results.push({ agentId: agent.id, status: "synced", staged: true });
        continue;
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
        const selectedHermesModelConfig = defaultProvider
          ? persistedModelConfig
            ? attachHermesCustomApiKey(persistedModelConfig, defaultProvider, envVars)
            : hermesModelConfig
          : null;
        if (
          onlyIfAuthPresent &&
          Object.keys(envVars).length === 0 &&
          !persistedModelConfig &&
          !hermesModelConfig
        ) {
          results.push({ agentId: agent.id, status: "skipped" });
          continue;
        }
        const managedHermesEnv = {
          ...envVars,
          ...buildHermesRuntimeBootstrapEnv({
            envVars,
            modelConfig: selectedHermesModelConfig,
          }),
        };
        await reconcileManagedRuntimeEnv(agent, managedHermesEnv, "hermes", {
          extraManagedEnvNames,
        });
        const kubernetesAgent =
          typeof containerManager.isKubernetesAgent === "function" &&
          containerManager.isKubernetesAgent(agent);
        if (!kubernetesAgent && (selectedHermesModelConfig || !defaultProvider)) {
          const { persistHermesModelConfig } = require("./hermesUi");
          await persistHermesModelConfig(agent, selectedHermesModelConfig || {});
        }
        if (!kubernetesAgent) {
          await writeHermesEnvToContainer(agent, envVars, selectedHermesModelConfig);
        }
        await restartAgentAndRefreshAddress(agent);
        const readiness = await waitForAgentReadiness(
          {
            host: agent.host,
            runtimeHost: agent.runtime_host,
            runtimePort: agent.runtime_port,
            gatewayHostPort: agent.gateway_host_port,
            gatewayHost: agent.gateway_host,
            gatewayPort: agent.gateway_port,
            checkGateway: false,
          },
          {
            beforeAttempt: () => assertRemoteHostAgentUse(agent, { includeProfile: false }),
          },
        );
        if (!readiness.ok) {
          throw new Error(
            `Agent runtime did not recover after env sync restart (${readiness.runtime?.error || "unreachable"})`,
          );
        }

        console.log(
          `[authSync] Synced Hermes env + model config to agent ${agent.id} (backend restarted)`,
        );
        await clearProviderAuthQuarantine(agent.id);
        results.push({ agentId: agent.id, status: "synced" });
        continue;
      }

      const authProfiles = await buildAuthProfilesForAgent(userId, agent.id);
      if (onlyIfAuthPresent && Object.keys(authProfiles).length === 0 && !modelCommand) {
        results.push({ agentId: agent.id, status: "skipped" });
        continue;
      }

      const mcpRuntimeState = await getEnabledMcpRuntimeState(agent.id);
      const managedEnv = await buildOpenClawManagedEnvForAgent(userId, agent.id, defaultProvider, {
        mcpRuntimeState,
      });
      await reconcileManagedRuntimeEnv(agent, managedEnv, "openclaw", {
        extraManagedEnvNames: [
          ...extraManagedEnvNames,
          ...(mcpRuntimeState.managedEnvNames || []),
          OPENCLAW_MANAGED_MCP_SERVERS_ENV,
        ],
      });

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
      const providerStateCommand = buildOpenClawManagedProviderStateCommand({
        customProviders,
        defaultModel: buildDefaultOpenClawModel(defaultProvider),
        managedModelProviderIds: MANAGED_OPENCLAW_MODEL_PROVIDER_IDS,
      });
      try {
        await runRuntimeCommand(agent, providerStateCommand, { timeout: 60000 });
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
        await runContainerCommand(agent, providerStateCommand);
      }

      const managedMcpServersCommand = buildOpenClawManagedMcpServersCommand(
        mcpRuntimeState.desiredServers || {},
      );
      try {
        await runRuntimeCommand(agent, managedMcpServersCommand, { timeout: 60000 });
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
        await runContainerCommand(agent, managedMcpServersCommand);
      }

      await restartAgentAndRefreshAddress(agent);

      // Readiness is intentionally the final runtime operation. Every auth,
      // provider, env, and default-model write above must be visible across
      // the single restart before callers receive a successful sync result.
      const readiness = await waitForAgentReadiness(
        {
          host: agent.host,
          runtimeHost: agent.runtime_host,
          runtimePort: agent.runtime_port,
          gatewayHostPort: agent.gateway_host_port,
          gatewayHost: agent.gateway_host,
          gatewayPort: agent.gateway_port,
        },
        {
          beforeAttempt: () => assertRemoteHostAgentUse(agent, { includeProfile: false }),
        },
      );
      if (!readiness.ok) {
        throw new Error(
          `Agent runtime did not recover after auth sync restart (${readiness.runtime?.error || readiness.gateway?.error || "unreachable"})`,
        );
      }

      console.log(`[authSync] Synced OpenClaw auth to agent ${agent.id} (backend restarted)`);
      await clearProviderAuthQuarantine(agent.id);
      results.push({ agentId: agent.id, status: "synced" });
    } catch (e) {
      console.warn(`[authSync] Failed for agent ${agent.id}:`, e.message);
      const stopped = await stopAgentAfterAuthSyncFailure(agent);
      if (stopped.stopError) {
        console.error(
          `[authSync] Failed to stop agent ${agent.id} after auth reconciliation failure:`,
          stopped.stopError,
        );
      }
      results.push({
        agentId: agent.id,
        status: "failed",
        error: e.message,
        code: e.code || null,
        runtimeStopped: stopped.runtimeStopped,
        statusPersisted: stopped.statusPersisted,
        quarantinePersisted: stopped.quarantinePersisted,
        requiresRedeploy: Boolean(e.requiresRedeploy),
        ...(stopped.quarantineError ? { quarantineError: stopped.quarantineError.message } : {}),
        ...(stopped.stopError ? { stopError: stopped.stopError.message } : {}),
      });
    }
  }
  return results;
}

module.exports = {
  syncAuthToUserAgents,
  resumeAgentWithProviderAuth,
  stageProviderAuthForStoppedAgent,
  PROVIDER_AUTH_PENDING_REASON,
  PROVIDER_AUTH_QUARANTINE_REASON,
  isProviderAuthStatusHoldReason,
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
