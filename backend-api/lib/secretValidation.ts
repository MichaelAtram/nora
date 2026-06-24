// @ts-nocheck
// Central validation for the process-level secrets the control plane depends
// on. Used by server.ts at boot (fail closed in production) and by doctor.ts
// for the Secret posture check, so both agree on what "weak" means.

// Mirrors agentHubSafety's placeholder detector: template-y prefixes plus the
// angle-bracket/mustache placeholders that ship in .env.example.
const PLACEHOLDER_RE = /^(your_|example|sample|placeholder|changeme|replace-me|test-|demo-)/i;

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

function looksLikePlaceholderSecret(value) {
  const v = String(value || "");
  return PLACEHOLDER_RE.test(v) || v.includes("<") || v.includes("{{");
}

// Validate one secret value. Returns a list of human-readable issues (empty =
// ok). `hex64` enforces the AES-256 key format crypto.ts requires.
function validateSecretValue(value, { minLength = 32, hex64 = false } = {}) {
  const v = String(value || "");
  const issues = [];
  if (!v) {
    issues.push("not set");
    return issues;
  }
  if (looksLikePlaceholderSecret(v)) issues.push("looks like a placeholder value");
  if (hex64) {
    // crypto.ts strips inline comments before validating; mirror that.
    const raw = v.split("#")[0].trim();
    if (!HEX_64_RE.test(raw)) issues.push("must be a 64-character hex string (32 bytes)");
  } else if (v.length < minLength) {
    issues.push(`shorter than the ${minLength}-character minimum`);
  }
  return issues;
}

// The secrets the control plane requires, with per-secret strictness.
// severity 'fail' = refuse to boot in production; 'warn' = log loudly.
// NORA_API_KEY_HASH_SECRET is a warn because lib/apiTokens.ts has a legacy
// fallback chain (ENCRYPTION_KEY, JWT_SECRET) that keeps existing installs
// working; failing closed on it would break them for no security gain.
const REQUIRED_SECRETS = [
  { env: "JWT_SECRET", label: "JWT signing secret", minLength: 32, severity: "fail" },
  {
    env: "NORA_API_KEY_HASH_SECRET",
    label: "API-key hash secret",
    minLength: 32,
    severity: "warn",
  },
  {
    env: "ENCRYPTION_KEY",
    label: "Credential encryption key (AES-256-GCM)",
    hex64: true,
    severity: "fail",
  },
];

// Evaluate every required secret against an env map. Returns
// [{ env, label, severity, issues: [...] }] for the ones with problems.
function validateRequiredSecrets(env = process.env) {
  const problems = [];
  for (const secret of REQUIRED_SECRETS) {
    const issues = validateSecretValue(env[secret.env], {
      minLength: secret.minLength,
      hex64: secret.hex64,
    });
    if (issues.length > 0) {
      problems.push({ env: secret.env, label: secret.label, severity: secret.severity, issues });
    }
  }
  return problems;
}

module.exports = {
  PLACEHOLDER_RE,
  REQUIRED_SECRETS,
  looksLikePlaceholderSecret,
  validateSecretValue,
  validateRequiredSecrets,
};
