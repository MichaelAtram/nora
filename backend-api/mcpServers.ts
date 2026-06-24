// @ts-nocheck
// Per-agent MCP server management. Lets an operator turn a *connected*
// integration into a Model Context Protocol server that the agent's OpenClaw
// runtime spawns over stdio. The runtime support is verified: OpenClaw
// (>= 2026.4.x) reads an `mcpServers` block from openclaw.json and launches
// each entry with StdioClientTransport.
//
// The npm package + transport come from the integration catalog (the source of
// truth, `mcp.available === true`). This module adds the one thing the catalog
// can't: the mapping from a provider's stored credential to the specific env
// var its MCP server reads — which is NOT the generic name the worker injects
// for tools (e.g. the GitLab MCP server wants GITLAB_PERSONAL_ACCESS_TOKEN, not
// the GITLAB_TOKEN the tool layer uses).
//
// Scope: the four single-token (api_key) providers whose credential maps
// cleanly to one env var. postgresql (needs a POSTGRES_URL assembled from a
// multi-field credential) and the file-credential providers (google-drive,
// kubernetes) are deliberately deferred.

const db = require("./db");
const { loadCatalog } = require("./integrations/catalog/catalogLoader");

// provider id -> how to turn its decrypted credential into MCP server env.
//   primaryEnv: the env var the MCP server reads the access token from.
//   configEnv:  optional map of decrypted-config key -> env var (e.g. self-hosted URL).
const SUPPORTED_MCP_PROVIDERS = {
  gitlab: {
    primaryEnv: "GITLAB_PERSONAL_ACCESS_TOKEN",
    configEnv: { api_url: "GITLAB_API_URL", base_url: "GITLAB_API_URL" },
  },
  notion: { primaryEnv: "NOTION_TOKEN" },
  stripe: { primaryEnv: "STRIPE_SECRET_KEY" },
  supabase: { primaryEnv: "SUPABASE_ACCESS_TOKEN" },
};

function isSupportedProvider(provider) {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_MCP_PROVIDERS, provider);
}

// Catalog entries for the supported providers that actually declare a usable
// stdio MCP server. Returns [{ provider, name, npmPackage, docsUrl, notes }].
function loadMcpCatalog(catalog = loadCatalog()) {
  const items = Array.isArray(catalog) ? catalog : [];
  const out = [];
  for (const item of items) {
    const provider = item?.id || item?.provider;
    if (!provider || !isSupportedProvider(provider)) continue;
    const mcp = item.mcp;
    if (!mcp || mcp.available !== true || mcp.transport !== "stdio" || !mcp.npmPackage) continue;
    out.push({
      provider,
      name: item.name || provider,
      npmPackage: mcp.npmPackage,
      docsUrl: mcp.docsUrl || null,
      notes: mcp.notes || null,
    });
  }
  return out;
}

function normalizeEnabledIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const id = typeof entry === "string" ? entry : entry?.provider;
    if (id && isSupportedProvider(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

async function getAgentMcpServerIds(agentId, { dbClient = db } = {}) {
  const result = await dbClient.query("SELECT mcp_servers FROM agents WHERE id = $1", [agentId]);
  if (result.rows.length === 0) return null; // agent not found
  return normalizeEnabledIds(result.rows[0].mcp_servers);
}

// Persist the enabled provider ids (validated against the supported set).
async function setAgentMcpServerIds(agentId, providerIds, { dbClient = db } = {}) {
  const ids = normalizeEnabledIds(providerIds);
  await dbClient.query("UPDATE agents SET mcp_servers = $1::jsonb WHERE id = $2", [
    JSON.stringify(ids),
    agentId,
  ]);
  return ids;
}

// For the management UI: every supported MCP server, annotated with whether the
// agent has the integration connected and whether the server is enabled.
async function getAvailableMcpServers(agentId, { dbClient = db, catalog } = {}) {
  const enabledIds = (await getAgentMcpServerIds(agentId, { dbClient })) || [];
  const connectedResult = await dbClient.query(
    "SELECT DISTINCT provider FROM integrations WHERE agent_id = $1 AND status = 'active'",
    [agentId],
  );
  const connected = new Set(connectedResult.rows.map((r) => r.provider));
  return loadMcpCatalog(catalog).map((entry) => ({
    provider: entry.provider,
    name: entry.name,
    npmPackage: entry.npmPackage,
    docsUrl: entry.docsUrl,
    notes: entry.notes,
    connected: connected.has(entry.provider),
    enabled: enabledIds.includes(entry.provider),
  }));
}

// PURE: turn the agent's enabled ids + already-decrypted integration creds into
// the entries buildMcpServersConfig expects. The worker calls this at deploy
// (it has decrypted tokens in hand) — no DB or crypto here, so it is unit
// testable. integrationsByProvider: { gitlab: { token, config: {api_url} } }.
// An enabled provider with no connected/credentialed integration is skipped.
function resolveMcpEntries({ enabledIds = [], integrationsByProvider = {}, catalog } = {}) {
  const byProvider = Object.fromEntries(loadMcpCatalog(catalog).map((e) => [e.provider, e]));
  const entries = [];
  for (const provider of normalizeEnabledIds(enabledIds)) {
    const cat = byProvider[provider];
    const mapping = SUPPORTED_MCP_PROVIDERS[provider];
    const integration = integrationsByProvider[provider];
    if (!cat || !mapping || !integration || !integration.token) continue;
    const env = { [mapping.primaryEnv]: integration.token };
    const config = integration.config || {};
    for (const [cfgKey, envVar] of Object.entries(mapping.configEnv || {})) {
      if (config[cfgKey]) env[envVar] = String(config[cfgKey]);
    }
    entries.push({ name: provider, npmPackage: cat.npmPackage, env });
  }
  return entries;
}

module.exports = {
  SUPPORTED_MCP_PROVIDERS,
  isSupportedProvider,
  loadMcpCatalog,
  normalizeEnabledIds,
  getAgentMcpServerIds,
  setAgentMcpServerIds,
  getAvailableMcpServers,
  resolveMcpEntries,
};
