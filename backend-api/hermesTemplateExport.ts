// @ts-nocheck
const db = require("./db");
const { runContainerCommand } = require("./authSync");
const { buildHermesPythonCommand } = require("./hermesUi");
const { normalizeTemplatePayload } = require("./agentPayloads");
const {
  normalizeSavedHermesSkillEntries,
} = require("../agent-runtime/lib/hermesSkillsReconciliation");

// Live-capture root and caps for Hermes Agent Hub bundles. The workspace tree
// is the operator-authored surface of a Hermes agent (notes, docs, scripts);
// caps keep a busy workspace from producing multi-hundred-megabyte bundles.
const HERMES_TEMPLATE_WORKSPACE_ROOT = "/opt/data/workspace";
const HERMES_TEMPLATE_MAX_FILE_BYTES = 1024 * 1024;
const HERMES_TEMPLATE_MAX_FILES = 200;
const HERMES_TEMPLATE_CAPTURE_TIMEOUT_MS = 120000;
// Skipped-path lists in bundle metadata are informational; cap them so a
// pathological workspace cannot bloat the listing snapshot itself.
const HERMES_TEMPLATE_MAX_SKIPPED_PATHS = 50;

function decodeMaybeJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return typeof value === "object" ? value : fallback;
}

function cleanConfigString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the in-container capture command for a Hermes agent's workspace.
 *
 * The Python walk excludes the Nora-generated integration artifacts (the
 * `integrations/` directory, `integrations*.json` manifests, and
 * `NORA_INTEGRATIONS.md` — the same set `hermesManifest` writes and the
 * migration reader excludes), every dotfile/dot-directory (`.env`, `.nora`,
 * caches), files above the per-file byte cap, and everything past the total
 * file cap. The result is emitted as one base64-wrapped JSON line because exec
 * streams can mangle raw JSON, and base64 survives them unchanged.
 *
 * @returns {string} Shell command that prints base64-encoded capture JSON.
 */
function buildHermesWorkspaceCaptureCommand() {
  const script = `
import base64
import json
import os

root = ${JSON.stringify(HERMES_TEMPLATE_WORKSPACE_ROOT)}
max_file_bytes = ${HERMES_TEMPLATE_MAX_FILE_BYTES}
max_files = ${HERMES_TEMPLATE_MAX_FILES}
max_skipped_paths = ${HERMES_TEMPLATE_MAX_SKIPPED_PATHS}
excluded_dir_names = {"integrations"}
excluded_file_names = {"NORA_INTEGRATIONS.md"}

files = []
skipped_files = []
truncated = False

for current_root, dir_names, file_names in os.walk(root):
    # Prune excluded and dot-directories in place so os.walk never descends
    # into them; sorting keeps the capture deterministic.
    dir_names[:] = sorted(
        name
        for name in dir_names
        if not name.startswith(".") and name not in excluded_dir_names
    )
    rel_root = os.path.relpath(current_root, root)
    if rel_root == ".":
        rel_root = ""
    for name in sorted(file_names):
        if name.startswith("."):
            continue
        if name in excluded_file_names:
            continue
        if name.startswith("integrations") and name.endswith(".json"):
            continue
        rel_path = rel_root + "/" + name if rel_root else name
        abs_path = os.path.join(current_root, name)
        if os.path.islink(abs_path) or not os.path.isfile(abs_path):
            continue
        try:
            size = os.path.getsize(abs_path)
        except OSError:
            skipped_files.append(rel_path)
            continue
        if size > max_file_bytes:
            skipped_files.append(rel_path)
            continue
        if len(files) >= max_files:
            truncated = True
            break
        try:
            with open(abs_path, "rb") as handle:
                content = handle.read()
        except OSError:
            skipped_files.append(rel_path)
            continue
        files.append({
            "path": rel_path,
            "contentBase64": base64.b64encode(content).decode("ascii"),
        })
    if truncated:
        break

payload = {
    "files": files,
    "truncated": truncated,
    "skippedFileCount": len(skipped_files),
    "skippedFiles": skipped_files[:max_skipped_paths],
}
print(base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii"))
`;

  return buildHermesPythonCommand(script);
}

function parseHermesCaptureOutput(output) {
  const encoded = String(output || "").trim();
  if (!encoded) {
    throw new Error("Hermes workspace capture returned empty output");
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (error) {
    const nextError = new Error(
      `Unexpected Hermes workspace capture output: ${encoded.slice(0, 200) || error.message}`,
    );
    nextError.cause = error;
    throw nextError;
  }
}

/**
 * Capture a Hermes agent's live `/opt/data/workspace` tree as a normalized
 * Agent Hub template payload.
 *
 * There is deliberately no stored-template fallback: Hermes agents do not keep
 * a durable template_payload the way OpenClaw agents do, so the runtime must be
 * reachable. Callers gate on running/warning status before invoking this.
 *
 * @param {Object} agent - Running Hermes agent row to capture.
 * @returns {Promise<Object>} Normalized payload with `metadata.runtimeFamily`
 *   set to "hermes" and capture truncation flags when limits were hit.
 */
async function buildHermesTemplatePayloadFromAgent(agent) {
  const result = await runContainerCommand(agent, buildHermesWorkspaceCaptureCommand(), {
    timeout: HERMES_TEMPLATE_CAPTURE_TIMEOUT_MS,
  });
  const captured = parseHermesCaptureOutput(result?.output);
  const files = Array.isArray(captured?.files) ? captured.files : [];
  const truncated = captured?.truncated === true;
  const skippedFileCount = Number.parseInt(captured?.skippedFileCount, 10) || 0;
  const skippedFiles = Array.isArray(captured?.skippedFiles)
    ? captured.skippedFiles.map((entry) => String(entry || "")).filter(Boolean)
    : [];

  if (truncated || skippedFileCount > 0) {
    console.warn(
      `Hermes template capture for agent ${agent?.id || "unknown"} skipped content: ` +
        `${skippedFileCount} oversized or unreadable file(s)` +
        (truncated ? `; file list truncated at ${HERMES_TEMPLATE_MAX_FILES}` : ""),
    );
  }

  return normalizeTemplatePayload({
    files,
    metadata: {
      runtimeFamily: "hermes",
      source: "hermes-live-capture",
      capturedAt: new Date().toISOString(),
      ...(truncated ? { captureTruncated: true } : {}),
      ...(skippedFileCount > 0
        ? { captureSkippedFileCount: skippedFileCount, captureSkippedFiles: skippedFiles }
        : {}),
    },
  });
}

/**
 * Build the Hermes-specific bundle metadata for an Agent Hub listing: the
 * agent's saved skills (re-normalized through the shared reconciliation
 * module) and its model selection restricted to non-secret fields.
 *
 * `hermes_runtime_state.model_config` is written through
 * `normalizeHermesModelConfig` and should already be key-free, but this picker
 * fails closed regardless: only `{provider, defaultModel, baseUrl}` ever cross
 * the hub boundary — never API keys.
 *
 * @param {Object} agent - Hermes agent row (including `hermes_skills`).
 * @param {Object} [dbClient=db] - Database client used to read model config.
 * @returns {Promise<Object>} Metadata fields to merge into the bundle payload.
 */
async function buildHermesBundleMetadata(agent, dbClient = db) {
  const result = await dbClient.query(
    "SELECT model_config FROM hermes_runtime_state WHERE agent_id = $1 LIMIT 1",
    [agent.id],
  );
  const rawModelConfig = decodeMaybeJson(result.rows[0]?.model_config, {});

  return {
    runtimeFamily: "hermes",
    hermesSkills: normalizeSavedHermesSkillEntries(decodeMaybeJson(agent?.hermes_skills, [])),
    hermesModelConfig: {
      provider: cleanConfigString(rawModelConfig.provider),
      defaultModel: cleanConfigString(rawModelConfig.defaultModel),
      baseUrl: cleanConfigString(rawModelConfig.baseUrl),
    },
  };
}

module.exports = {
  HERMES_TEMPLATE_MAX_FILES,
  HERMES_TEMPLATE_MAX_FILE_BYTES,
  HERMES_TEMPLATE_WORKSPACE_ROOT,
  buildHermesBundleMetadata,
  buildHermesTemplatePayloadFromAgent,
  buildHermesWorkspaceCaptureCommand,
};
