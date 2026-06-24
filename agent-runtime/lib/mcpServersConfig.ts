// @ts-nocheck
// Pure builder for the openclaw.json `mcpServers` block. OpenClaw (>= 2026.4.x)
// reads this map and launches each entry as a stdio MCP client (verified
// against the runtime bundle: command/args/env stdio shape). `entries` is
// already credential-resolved upstream, so this is a dependency-free shape
// transform — kept in its own module so it can be unit-tested without loading
// the rest of the runtime bootstrap. Keyed by server name:
//   { "<name>": { command: "npx", args: ["-y", "<pkg>", ...], env: { ... } } }
function buildMcpServersConfig(entries = []) {
  const servers = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !entry.name || !entry.npmPackage) continue;
    const extraArgs = Array.isArray(entry.args) ? entry.args : [];
    const env =
      entry.env && typeof entry.env === "object"
        ? Object.fromEntries(
            Object.entries(entry.env).filter(([, value]) => value != null && value !== ""),
          )
        : {};
    servers[entry.name] = {
      command: "npx",
      args: ["-y", entry.npmPackage, ...extraArgs],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  return servers;
}

module.exports = { buildMcpServersConfig };
