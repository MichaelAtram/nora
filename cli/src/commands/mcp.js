// `nora mcp` — run the Nora MCP server (stdio) so MCP clients like Claude
// Code, Claude Desktop, or Cursor can operate this control plane. The server
// itself lives in the separate @noraai/mcp-server package; this command resolves
// it (local checkout first, then npx) and hands over stdio. Host + token come
// from the same config `nora login` writes, exported as env for the child.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { load } = require("../config");

function localServerEntrypoint() {
  // Monorepo layout: cli/src/commands/mcp.js -> ../../../mcp-server/src/index.js
  const candidate = path.join(__dirname, "..", "..", "..", "mcp-server", "src", "index.js");
  return fs.existsSync(candidate) ? candidate : null;
}

async function run(args, flags) {
  const config = load();
  const env = { ...process.env };
  if (config.host && !env.NORA_API_URL) env.NORA_API_URL = config.host;
  if (config.token && !env.NORA_API_KEY) env.NORA_API_KEY = config.token;
  if (flags["allow-destructive"]) env.NORA_MCP_ALLOW_DESTRUCTIVE = "true";

  const local = localServerEntrypoint();
  const [command, commandArgs] = local
    ? [process.execPath, [local]]
    : ["npx", ["--yes", "@noraai/mcp-server"]];

  // stdio is the MCP transport — inherit all three streams untouched.
  const child = spawn(command, commandArgs, { env, stdio: "inherit" });
  const code = await new Promise((resolve) => {
    child.on("close", resolve);
    child.on("error", (error) => {
      console.error(`Failed to start MCP server: ${error.message}`);
      resolve(1);
    });
  });
  if (code) {
    const error = new Error(`MCP server exited with code ${code}`);
    error.status = code;
    throw error;
  }
}

module.exports = {
  describe: "Run the Nora MCP server on stdio (for Claude Code, Claude Desktop, Cursor)",
  run,
};
