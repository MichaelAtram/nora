import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const infraDir = path.join(repoRoot, "infra");

function run(command, args, env = {}) {
  execFileSync(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    stdio: "inherit",
  });
}

function walk(dir, predicate, matches = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, predicate, matches);
      continue;
    }
    if (predicate(fullPath)) {
      matches.push(fullPath);
    }
  }
  return matches;
}

function validateComposeFiles() {
  const composeEnv = {
    NORA_ENV_FILE: ".env.test",
    NGINX_CONFIG_FILE: "nginx.public.conf",
    NGINX_HTTP_PORT: "80",
  };

  run(
    "docker",
    ["compose", "--env-file", ".env.test", "-f", "docker-compose.e2e.yml", "config", "-q"],
    {
      NORA_ENV_FILE: ".env.test",
    },
  );
  run(
    "docker",
    [
      "compose",
      "--env-file",
      ".env.test",
      "-f",
      "docker-compose.yml",
      "-f",
      "infra/docker-compose.public-prod.yml",
      "config",
      "-q",
    ],
    composeEnv,
  );
  run(
    "docker",
    [
      "compose",
      "--env-file",
      ".env.test",
      "-f",
      "docker-compose.yml",
      "-f",
      "infra/docker-compose.public-prod.yml",
      "-f",
      "infra/docker-compose.public-tls.yml",
      "config",
      "-q",
    ],
    composeEnv,
  );
}

function validateKindConfig(filePath) {
  const parsed = parse(fs.readFileSync(filePath, "utf8"));
  if (parsed?.kind !== "Cluster") {
    throw new Error(`${path.relative(repoRoot, filePath)} must declare kind: Cluster`);
  }
  if (!String(parsed?.apiVersion || "").startsWith("kind.x-k8s.io/")) {
    throw new Error(`${path.relative(repoRoot, filePath)} must use a kind.x-k8s.io apiVersion`);
  }
  if (!Array.isArray(parsed?.nodes) || parsed.nodes.length === 0) {
    throw new Error(`${path.relative(repoRoot, filePath)} must declare at least one node`);
  }
}

// Dummy values so charts that `fail` on missing required secrets still render
// in CI. Never reuse these anywhere real.
const HELM_CI_VALUES = [
  "--set",
  "secrets.jwtSecret=ci-validate-dummy-jwt-secret-0000000000",
  "--set",
  "secrets.encryptionKey=ci-validate-dummy-encryption-key-00000000",
  "--set",
  "secrets.backupEncryptionKey=ci-validate-dummy-backup-key-000000000",
  "--set",
  "secrets.apiKeyHashSecret=ci-validate-dummy-hash-secret-0000000000",
  "--set",
  "secrets.dbPassword=ci-validate-dummy-db-password",
];

// A second permutation so the default render isn't the only thing validated:
// turns on Ingress and points DB/Redis at external services (exercising the
// external.* branches and the ingress template, none of which render by default).
const HELM_CI_ALT_VALUES = [
  ...HELM_CI_VALUES,
  "--set",
  "ingress.enabled=true",
  "--set",
  "ingress.host=nora.ci.example.com",
  "--set",
  "postgresql.enabled=false",
  "--set",
  "postgresql.external.host=db.ci.example.com",
  "--set",
  "redis.enabled=false",
  "--set",
  "redis.external.host=redis.ci.example.com",
  "--set",
  "nginx.service.type=NodePort",
];

// Pin the Kubernetes schema version kubeconform validates against, instead of
// the floating (latest dev) "master" schemas it uses by default.
const KUBECONFORM_K8S_VERSION = "1.30.0";

function runCapture(command, args) {
  return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8" });
}

function kubeconformRendered(rendered, label) {
  const renderedPath = path.join(repoRoot, `.helm-rendered-ci-${label}.yaml`);
  fs.writeFileSync(renderedPath, rendered);
  try {
    run("kubeconform", [
      "-summary",
      "-strict",
      "-kubernetes-version",
      KUBECONFORM_K8S_VERSION,
      path.relative(repoRoot, renderedPath),
    ]);
  } finally {
    fs.unlinkSync(renderedPath);
  }
}

// Walk a chart's template files and report whether any of them reads the given
// `.Files.Get "<relPath>"` — used to make the drift guard fail closed when a
// referenced vendored file is deleted (Helm's .Files.Get silently returns "").
function chartReferencesFile(chartDir, relPath) {
  const templatesDir = path.join(chartDir, "templates");
  if (!fs.existsSync(templatesDir)) return false;
  const needle = `.Files.Get "${relPath}"`;
  return walk(templatesDir, (p) => /\.(ya?ml|tpl)$/i.test(p)).some((p) =>
    fs.readFileSync(p, "utf8").includes(needle),
  );
}

function validateHelmCharts(chartFiles) {
  for (const chartFile of chartFiles) {
    const chartDir = path.dirname(chartFile);
    run("helm", ["lint", chartDir, ...HELM_CI_VALUES]);

    // kubeconform the *rendered* manifests — raw template files are not YAML.
    // Validate both the default values and the alternate permutation so the
    // Ingress and external-DB/Redis branches don't ship unvalidated.
    kubeconformRendered(
      runCapture("helm", ["template", "nora-ci", chartDir, ...HELM_CI_VALUES]),
      "default",
    );
    kubeconformRendered(
      runCapture("helm", ["template", "nora-ci", chartDir, ...HELM_CI_ALT_VALUES]),
      "alt",
    );

    // The nora chart vendors backend-api/db_schema.sql for postgres initdb. Fail
    // loudly when the copies drift — and fail closed when a referenced vendored
    // file is missing entirely (an empty .Files.Get would otherwise pass green).
    const vendoredSchema = path.join(chartDir, "files", "db_schema.sql");
    if (chartReferencesFile(chartDir, "files/db_schema.sql") && !fs.existsSync(vendoredSchema)) {
      throw new Error(
        `${path.relative(repoRoot, chartDir)} references files/db_schema.sql via .Files.Get but ` +
          `${path.relative(repoRoot, vendoredSchema)} is missing — ` +
          "run: cp backend-api/db_schema.sql " +
          path.relative(repoRoot, vendoredSchema),
      );
    }
    if (fs.existsSync(vendoredSchema)) {
      const canonical = fs.readFileSync(
        path.join(repoRoot, "backend-api", "db_schema.sql"),
        "utf8",
      );
      if (fs.readFileSync(vendoredSchema, "utf8") !== canonical) {
        throw new Error(
          `${path.relative(repoRoot, vendoredSchema)} is out of sync with backend-api/db_schema.sql — ` +
            "run: cp backend-api/db_schema.sql " +
            path.relative(repoRoot, vendoredSchema),
        );
      }
    }
  }
}

function validateKubernetesManifests(manifestFiles) {
  if (manifestFiles.length === 0) {
    console.log("No Kubernetes deployment manifests found under infra/.");
    return;
  }

  run("kubeconform", ["-summary", ...manifestFiles.map((file) => path.relative(repoRoot, file))]);
}

validateComposeFiles();

const chartFiles = walk(infraDir, (fullPath) => path.basename(fullPath) === "Chart.yaml");
const chartDirs = chartFiles.map((chartFile) => path.dirname(chartFile));
const yamlFiles = walk(infraDir, (fullPath) => /\.(ya?ml)$/i.test(fullPath));
const manifestFiles = [];

for (const yamlFile of yamlFiles) {
  const relativePath = path.relative(repoRoot, yamlFile);
  if (relativePath.startsWith("infra/docker-compose.")) {
    continue;
  }

  // Helm chart contents (templates, values, Chart.yaml) are validated through
  // helm lint + helm template above, not as raw manifests.
  if (chartDirs.some((chartDir) => yamlFile.startsWith(chartDir + path.sep))) {
    continue;
  }

  const content = fs.readFileSync(yamlFile, "utf8");
  if (/apiVersion:\s*kind\.x-k8s\.io\//.test(content)) {
    validateKindConfig(yamlFile);
    continue;
  }

  if (/^\s*apiVersion:/m.test(content) && /^\s*kind:/m.test(content)) {
    manifestFiles.push(yamlFile);
  }
}

validateHelmCharts(chartFiles);
validateKubernetesManifests(manifestFiles);

console.log("Infrastructure validation passed.");
