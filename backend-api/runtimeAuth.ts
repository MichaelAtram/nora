// @ts-nocheck
// Resolves the bearer headers for calling an agent's runtime sidecar (:9090),
// which authenticates every route except /health with the per-agent gateway
// token. Most agent objects passed around the backend already carry
// gateway_token, but some loading queries omit it (e.g. the auth-sync query);
// fall back to a cheap indexed lookup so no caller path can silently send an
// empty token and get a 401.

const db = require("./db");
const { decrypt } = require("./crypto");
const { buildRuntimeAuthHeaders } = require("../agent-runtime/lib/agentEndpoints");

async function runtimeAuthHeaders(agent) {
  // gateway_token is encrypted at rest (AES-256-GCM). decrypt() is transparent
  // to legacy plaintext tokens (colon-free hex), so it is safe to call here
  // whether the value came from an encrypted column or an in-memory plaintext
  // token. This is the central choke point for backend → runtime auth headers
  // (channels, integration sync, Hermes API, etc.).
  let token = agent && agent.gateway_token ? decrypt(agent.gateway_token) : null;
  if (!token && agent && agent.id) {
    try {
      const result = await db.query("SELECT gateway_token FROM agents WHERE id = $1", [agent.id]);
      token = result.rows[0]?.gateway_token ? decrypt(result.rows[0].gateway_token) : null;
    } catch {
      token = null;
    }
  }
  return buildRuntimeAuthHeaders(token);
}

module.exports = { runtimeAuthHeaders };
