# Hermes Multiple Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a single Hermes agent runtime host multiple isolated Hermes profiles that Nora can create, detect, run concurrently, and switch between (with per-profile config) from the agent dashboard.

**Architecture:** A Hermes agent stays one container. The existing `HERMES_HOME=/opt/data` is the `default` profile; named profiles live at `/opt/data/profiles/<name>`. The default profile's gateway remains PID 1; each named profile runs an extra background `hermes gateway run` with `API_SERVER_ENABLED=false`. Nora reads/writes every profile's config via `docker exec` with `HERMES_HOME` scoped, stores config per `(agent, profile)`, and the dashboard gets a profile selector scoping the **Channels** panel (exec-based). Cron/Chat/Status proxy the runtime API server (which named profiles don't run), so they stay default-only in v1.

**Tech Stack:** Node 24, Express (backend-api), Postgres (append-only versioned migrations), Jest (backend tests), Vitest + `tsx/cjs` (agent-runtime tests), Next.js/React (frontend-dashboard), dockerode (Hermes adapter).

## Global Constraints

- Backend runtime files are `// @ts-nocheck` CommonJS (`require`/`module.exports`) — match the surrounding style; do **not** convert to ESM/TS.
- `agent_id` columns are **UUID** (see `hermes_runtime_state`), not integer.
- DB migrations are **append-only and positional**: add new SQL entries at the **end** of the `migrations` array in `backend-api/server.ts` (array currently closes at line ~2283). Never reorder/edit existing entries. Also update `backend-api/db_schema.sql` (the fresh-install schema) to match.
- `workers/provisioner/backends/` and `agent-runtime/lib/` are **shared blast-radius zones** (mounted into both backend-api and the worker). After editing them, verify both consumers.
- The Hermes container has **no user systemd** — never use `hermes gateway start` (managed service); background `hermes gateway run` instead (mirrors how the dashboard is backgrounded today).
- Profile name validation: `^[a-z0-9][a-z0-9-]{0,62}$`, and the literal `default` is **reserved** (represents the default profile; cannot be created/deleted). Validate before any value reaches a shell/exec.
- Deploy-target scope: **local Docker + remote-hermes only**. Kubernetes Hermes agents (`containerManager.isKubernetesAgent(agent)`) must reject profile management with a clear error; the frontend hides profile controls for them.
- Default profile keeps today's behavior exactly (including full-container restart on config change). Named profiles must **not** trigger a container restart.

---

## File Structure

**Create:**
- `backend-api/hermesProfiles.ts` — profile registry + lifecycle helpers (list/create/delete/gateway start-stop-restart, reconciliation). Kept separate from `hermesUi.ts` so channel/model logic and profile-lifecycle logic each stay focused.
- `backend-api/__tests__/hermesProfiles.test.ts` — Jest tests for the above.
- `frontend-dashboard/components/agents/hermes/ProfileSwitcher.tsx` — the selector + create/delete/start-stop control.

**Modify:**
- `agent-runtime/lib/hermesRuntimeBootstrap.ts` — add profile-home resolution, name validation, and the profile-gateway launch/pidfile shell snippets (shared, testable).
- `workers/provisioner/backends/hermes.ts` — `buildHermesStartCommand()` launches all on-disk profile gateways after the default bootstrap.
- `backend-api/hermesUi.ts` — thread a `profile` argument through the Python-exec helpers and per-`(agent, profile)` state functions.
- `backend-api/routes/agents.ts` — new profile routes + `?profile=` on existing hermes-ui routes.
- `backend-api/server.ts` — append the two DB migrations.
- `backend-api/db_schema.sql` — fresh-install schema for the new/changed tables.
- `frontend-dashboard/components/agents/HermesWebUITab.tsx` — mount `ProfileSwitcher`, hold `selectedProfile`, pass it to `ChannelsPanel`, and show a default-only banner on the Cron/Chat/Status sub-tabs when a non-default profile is selected.
- `frontend-dashboard/components/agents/hermes/ChannelsPanel.tsx` — accept a `profile` prop and append `?profile=` to its fetches. (Cron/Chat/Status panels are **not** profile-scoped in v1 — they proxy the runtime API server, which named profiles don't run.)
- `backend-api/__tests__/hermesUi.test.ts` — extend for profile scoping.
- `agent-runtime/__tests__/hermesRuntimeBootstrap.test.ts` — create if absent; test the new helpers.

---

## Phase 1 — Data model

### Task 1: `hermes_profiles` table + per-profile `hermes_runtime_state` (migration + schema)

**Files:**
- Modify: `backend-api/server.ts` (append to `migrations` array before its closing `];` at ~line 2283)
- Modify: `backend-api/db_schema.sql:286-292` (the `hermes_runtime_state` block) and add a `hermes_profiles` block after it
- Test: `backend-api/__tests__/hermesProfilesMigration.test.ts` (create)

**Interfaces:**
- Produces: table `hermes_profiles(agent_id UUID, name TEXT, display_name TEXT, is_default BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, PRIMARY KEY(agent_id, name))`; `hermes_runtime_state` gains `profile_name TEXT NOT NULL DEFAULT 'default'` with `UNIQUE(agent_id, profile_name)` replacing the `agent_id` primary key.

- [ ] **Step 1: Write the failing test**

Create `backend-api/__tests__/hermesProfilesMigration.test.ts`. This test asserts the migration SQL strings exist and are shaped correctly (the repo already tests migration text this way; a live-Postgres test is covered by `migrationPostgres.test.ts`).

```javascript
// @ts-nocheck
const fs = require("fs");
const path = require("path");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.ts"), "utf8");
const schemaSrc = fs.readFileSync(path.join(__dirname, "..", "db_schema.sql"), "utf8");

describe("hermes profiles migration", () => {
  it("adds profile_name to hermes_runtime_state", () => {
    expect(serverSrc).toContain("ALTER TABLE hermes_runtime_state ADD COLUMN IF NOT EXISTS profile_name");
  });

  it("creates the hermes_profiles table in a migration", () => {
    expect(serverSrc).toContain("CREATE TABLE IF NOT EXISTS hermes_profiles");
  });

  it("backfills a default profile row for hermes agents", () => {
    expect(serverSrc).toContain("INSERT INTO hermes_profiles");
    expect(serverSrc).toContain("is_default");
  });

  it("keeps the fresh-install schema in sync", () => {
    expect(schemaSrc).toContain("CREATE TABLE IF NOT EXISTS hermes_profiles");
    expect(schemaSrc).toMatch(/hermes_runtime_state[\s\S]*profile_name/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-api && npx jest __tests__/hermesProfilesMigration.test.ts`
Expected: FAIL (strings not present yet).

- [ ] **Step 3: Append the migrations in `server.ts`**

Insert these entries at the END of the `migrations` array (just before the closing `];` at ~line 2283), preserving array order (each is a new positional version):

```javascript
    `ALTER TABLE hermes_runtime_state ADD COLUMN IF NOT EXISTS profile_name TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE hermes_runtime_state DROP CONSTRAINT IF EXISTS hermes_runtime_state_pkey`,
    `ALTER TABLE hermes_runtime_state ADD PRIMARY KEY (agent_id, profile_name)`,
    `CREATE TABLE IF NOT EXISTS hermes_profiles (
       agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
       name TEXT NOT NULL,
       display_name TEXT,
       is_default BOOLEAN NOT NULL DEFAULT FALSE,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       PRIMARY KEY (agent_id, name)
     )`,
    `INSERT INTO hermes_profiles (agent_id, name, display_name, is_default)
       SELECT id, 'default', 'Default', TRUE FROM agents WHERE runtime_family = 'hermes'
       ON CONFLICT (agent_id, name) DO NOTHING`,
```

- [ ] **Step 4: Update the fresh-install schema in `db_schema.sql`**

Replace the `hermes_runtime_state` block (lines 286-292) with:

```sql
CREATE TABLE IF NOT EXISTS hermes_runtime_state (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  profile_name TEXT NOT NULL DEFAULT 'default',
  model_config JSONB DEFAULT '{}',
  channel_configs JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (agent_id, profile_name)
);

CREATE TABLE IF NOT EXISTS hermes_profiles (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_name TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, name)
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend-api && npx jest __tests__/hermesProfilesMigration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend-api/server.ts backend-api/db_schema.sql backend-api/__tests__/hermesProfilesMigration.test.ts
git commit -m "feat(hermes): per-profile runtime state + hermes_profiles table"
```

---

## Phase 2 — Runtime profile-home resolution & concurrent gateways

### Task 2: Profile-home resolution + name validation (shared contract)

**Files:**
- Modify: `agent-runtime/lib/hermesRuntimeBootstrap.ts`
- Test: `agent-runtime/__tests__/hermesRuntimeBootstrap.test.ts` (create)

**Interfaces:**
- Produces (exported from `hermesRuntimeBootstrap.ts`):
  - `HERMES_DEFAULT_HOME = "/opt/data"`
  - `HERMES_PROFILES_SUBDIR = "profiles"`
  - `isValidHermesProfileName(name): boolean` — true for `default` and for `^[a-z0-9][a-z0-9-]{0,62}$`.
  - `resolveHermesProfileHome(profileName): string` — `default` → `/opt/data`; a valid name → `/opt/data/profiles/<name>`; throws `Error` (message `Invalid Hermes profile name: <name>`) for anything else.

- [ ] **Step 1: Write the failing test**

Create `agent-runtime/__tests__/hermesRuntimeBootstrap.test.ts`:

```javascript
import { describe, expect, it } from "vitest";
import "tsx/cjs";

const bootstrap = require("../lib/hermesRuntimeBootstrap.ts");
const { isValidHermesProfileName, resolveHermesProfileHome } = bootstrap;

describe("hermes profile home", () => {
  it("accepts default and valid slugs", () => {
    expect(isValidHermesProfileName("default")).toBe(true);
    expect(isValidHermesProfileName("coder")).toBe(true);
    expect(isValidHermesProfileName("michael-cto")).toBe(true);
  });

  it("rejects invalid names", () => {
    expect(isValidHermesProfileName("")).toBe(false);
    expect(isValidHermesProfileName("Bad_Name")).toBe(false);
    expect(isValidHermesProfileName("-lead")).toBe(false);
    expect(isValidHermesProfileName("../escape")).toBe(false);
  });

  it("maps default to /opt/data and named to the profiles subdir", () => {
    expect(resolveHermesProfileHome("default")).toBe("/opt/data");
    expect(resolveHermesProfileHome("coder")).toBe("/opt/data/profiles/coder");
  });

  it("throws on invalid names", () => {
    expect(() => resolveHermesProfileHome("../escape")).toThrow(/Invalid Hermes profile name/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-runtime && npx vitest run __tests__/hermesRuntimeBootstrap.test.ts`
Expected: FAIL (functions undefined).

- [ ] **Step 3: Implement in `hermesRuntimeBootstrap.ts`**

Add near the top (after the existing `const HERMES_*` declarations):

```javascript
const HERMES_DEFAULT_HOME = "/opt/data";
const HERMES_PROFILES_SUBDIR = "profiles";
const HERMES_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function isValidHermesProfileName(name) {
  const value = String(name || "");
  return value === "default" || HERMES_PROFILE_NAME_RE.test(value);
}

function resolveHermesProfileHome(profileName) {
  const value = String(profileName || "default");
  if (value === "default") return HERMES_DEFAULT_HOME;
  if (!HERMES_PROFILE_NAME_RE.test(value)) {
    throw new Error(`Invalid Hermes profile name: ${profileName}`);
  }
  return `${HERMES_DEFAULT_HOME}/${HERMES_PROFILES_SUBDIR}/${value}`;
}
```

Add all four to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-runtime && npx vitest run __tests__/hermesRuntimeBootstrap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-runtime/lib/hermesRuntimeBootstrap.ts agent-runtime/__tests__/hermesRuntimeBootstrap.test.ts
git commit -m "feat(hermes): profile-home resolution and name validation"
```

---

### Task 3: Profile-gateway launch + pidfile shell snippets (shared)

**Files:**
- Modify: `agent-runtime/lib/hermesRuntimeBootstrap.ts`
- Test: `agent-runtime/__tests__/hermesRuntimeBootstrap.test.ts`

**Interfaces:**
- Consumes: `resolveHermesProfileHome` (Task 2).
- Produces (exported):
  - `buildHermesProfileGatewayStartSnippet(home): string` — shell that launches `hermes gateway run` for `home` in the background with `API_SERVER_ENABLED=false`, writing `<home>/gateway.pid`. Assumes `$HERMES_BIN` is already set by the caller.
  - `buildHermesProfileGatewayStopSnippet(home): string` — kills the pid in `<home>/gateway.pid` (best-effort) and removes the file.
  - `buildAllProfilesGatewayLaunchSnippet(): string` — loops `/opt/data/profiles/*/` and runs the start snippet for each existing dir.

- [ ] **Step 1: Write the failing test**

Append to `agent-runtime/__tests__/hermesRuntimeBootstrap.test.ts`:

```javascript
const {
  buildHermesProfileGatewayStartSnippet,
  buildHermesProfileGatewayStopSnippet,
  buildAllProfilesGatewayLaunchSnippet,
} = bootstrap;

describe("hermes profile gateway snippets", () => {
  it("start snippet scopes HERMES_HOME, disables the API server, writes a pidfile", () => {
    const snippet = buildHermesProfileGatewayStartSnippet("/opt/data/profiles/coder");
    expect(snippet).toContain('HERMES_HOME="/opt/data/profiles/coder"');
    expect(snippet).toContain("API_SERVER_ENABLED=false");
    expect(snippet).toContain("gateway run");
    expect(snippet).toContain("/opt/data/profiles/coder/gateway.pid");
    expect(snippet).toContain("nohup");
  });

  it("stop snippet kills the pidfile process", () => {
    const snippet = buildHermesProfileGatewayStopSnippet("/opt/data/profiles/coder");
    expect(snippet).toContain("/opt/data/profiles/coder/gateway.pid");
    expect(snippet).toContain("kill");
  });

  it("launch-all loops the profiles dir", () => {
    const snippet = buildAllProfilesGatewayLaunchSnippet();
    expect(snippet).toContain("/opt/data/profiles/");
    expect(snippet).toContain("for ");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent-runtime && npx vitest run __tests__/hermesRuntimeBootstrap.test.ts`
Expected: FAIL (functions undefined).

- [ ] **Step 3: Implement in `hermesRuntimeBootstrap.ts`**

```javascript
function buildHermesProfileGatewayStartSnippet(home) {
  const safeHome = String(home);
  return [
    `HERMES_HOME="${safeHome}" API_SERVER_ENABLED=false nohup "$HERMES_BIN" gateway run >> "${safeHome}/gateway.log" 2>&1 &`,
    `echo $! > "${safeHome}/gateway.pid"`,
  ].join("\n");
}

function buildHermesProfileGatewayStopSnippet(home) {
  const safeHome = String(home);
  return [
    `if [ -f "${safeHome}/gateway.pid" ]; then`,
    `  kill "$(cat "${safeHome}/gateway.pid")" 2>/dev/null || true`,
    `  rm -f "${safeHome}/gateway.pid"`,
    `fi`,
  ].join("\n");
}

function buildAllProfilesGatewayLaunchSnippet() {
  return [
    `for prof_dir in "${HERMES_DEFAULT_HOME}/${HERMES_PROFILES_SUBDIR}"/*/; do`,
    `  [ -d "$prof_dir" ] || continue`,
    `  prof_home="\${prof_dir%/}"`,
    `  HERMES_HOME="$prof_home" API_SERVER_ENABLED=false nohup "$HERMES_BIN" gateway run >> "$prof_home/gateway.log" 2>&1 &`,
    `  echo $! > "$prof_home/gateway.pid"`,
    `done`,
  ].join("\n");
}
```

Add all three to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent-runtime && npx vitest run __tests__/hermesRuntimeBootstrap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent-runtime/lib/hermesRuntimeBootstrap.ts agent-runtime/__tests__/hermesRuntimeBootstrap.test.ts
git commit -m "feat(hermes): profile gateway launch/stop shell snippets"
```

---

### Task 4: Launch all profile gateways at container start

**Files:**
- Modify: `workers/provisioner/backends/hermes.ts:50-67` (`buildHermesStartCommand`)
- Test: `workers/provisioner/backends/__tests__/hermesStartCommand.test.ts` (create) — if `workers/provisioner/backends/__tests__` does not exist, create it; otherwise place the file alongside sibling tests.

**Interfaces:**
- Consumes: `buildAllProfilesGatewayLaunchSnippet` (Task 3).
- Produces: the container start command includes the profile-launch loop **after** the default bootstrap and **before** the default gateway `exec`.

- [ ] **Step 1: Write the failing test**

Create `workers/provisioner/backends/__tests__/hermesStartCommand.test.ts`:

```javascript
// @ts-nocheck
process.env.NODE_ENV = "test";
const HermesBackend = require("../hermes");

// buildHermesStartCommand is module-internal; assert via a tiny re-export.
const { __buildHermesStartCommandForTest } = require("../hermes");

describe("hermes start command", () => {
  it("launches named-profile gateways before exec-ing the default gateway", () => {
    const cmd = __buildHermesStartCommandForTest();
    expect(cmd).toContain("/opt/data/profiles/");
    expect(cmd).toContain("gateway run");
    // default gateway is still the exec'd primary
    expect(cmd).toContain('exec "$HERMES_BIN" gateway run');
    // profile loop precedes the exec of the primary gateway
    expect(cmd.indexOf("/opt/data/profiles/")).toBeLessThan(cmd.lastIndexOf('exec "$HERMES_BIN" gateway run'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-api && npx jest ../workers/provisioner/backends/__tests__/hermesStartCommand.test.ts` (the repo runs backend + worker Jest from `backend-api`; if this path is not picked up, run from repo root with `npx jest workers/provisioner/backends/__tests__/hermesStartCommand.test.ts`)
Expected: FAIL (`__buildHermesStartCommandForTest` undefined and loop absent).

- [ ] **Step 3: Implement in `hermes.ts`**

At the top of `hermes.ts`, add `buildAllProfilesGatewayLaunchSnippet` to the existing `require("../../../agent-runtime/lib/hermesRuntimeBootstrap")` destructure. Update `buildHermesStartCommand`:

```javascript
function buildHermesStartCommand() {
  const hermesRuntimeCommand = [
    "set -eu",
    "if [ -r /opt/nora-managed-env/apply.sh ]; then . /opt/nora-managed-env/apply.sh; fi",
    buildHermesRuntimeConfigBootstrapCommand(),
    `HERMES_BIN="${HERMES_BIN}"`,
    '[ -x "$HERMES_BIN" ] || HERMES_BIN="$(command -v hermes)"',
    `nohup "$HERMES_BIN" dashboard --host 0.0.0.0 --insecure --no-open >> ${HERMES_DASHBOARD_LOG} 2>&1 &`,
    // Launch every named profile's gateway in the background (default gateway is exec'd below).
    buildAllProfilesGatewayLaunchSnippet(),
    'exec "$HERMES_BIN" gateway run',
  ].join("\n");

  return [
    "set -eu",
    `exec ${HERMES_ENTRYPOINT} bash -lc ${shellSingleQuote(hermesRuntimeCommand)}`,
  ].join("\n");
}
```

At the bottom, add a test-only re-export next to `module.exports = HermesBackend;`:

```javascript
module.exports = HermesBackend;
module.exports.__buildHermesStartCommandForTest = buildHermesStartCommand;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest workers/provisioner/backends/__tests__/hermesStartCommand.test.ts` (from repo root)
Expected: PASS.

- [ ] **Step 5: Verify both consumers still import cleanly (shared blast radius)**

Run: `cd backend-api && node -e "require('../workers/provisioner/backends/hermes')" && echo OK`
Expected: prints `OK` (no throw).

- [ ] **Step 6: Commit**

```bash
git add workers/provisioner/backends/hermes.ts workers/provisioner/backends/__tests__/hermesStartCommand.test.ts
git commit -m "feat(hermes): launch all profile gateways at container start"
```

---

## Phase 3 — Backend config scoping per profile

### Task 5: Scope `hermesUi.ts` Python-exec helpers to a profile via `HERMES_HOME`

**Files:**
- Modify: `backend-api/hermesUi.ts` (`buildHermesPythonCommand`, `runHermesPython`, `runHermesPythonJson`)
- Test: `backend-api/__tests__/hermesUi.test.ts`

**Interfaces:**
- Consumes: `resolveHermesProfileHome` (Task 2, via `require("../agent-runtime/lib/hermesRuntimeBootstrap")`).
- Produces: `buildHermesPythonCommand(script, { profile = "default" } = {})` prefixes `export HERMES_HOME=<home>`; `runHermesPython(agent, script, { timeout, profile })` and `runHermesPythonJson(...)` forward `profile`.

- [ ] **Step 1: Write the failing test**

Append to `backend-api/__tests__/hermesUi.test.ts` (the file already imports from `../hermesUi`; add `buildHermesPythonCommand` to its destructure):

```javascript
describe("profile scoping in python command", () => {
  it("defaults to /opt/data", () => {
    const cmd = buildHermesPythonCommand("print('x')");
    expect(cmd).toContain('export HERMES_HOME="/opt/data"');
  });

  it("scopes to a named profile home", () => {
    const cmd = buildHermesPythonCommand("print('x')", { profile: "coder" });
    expect(cmd).toContain('export HERMES_HOME="/opt/data/profiles/coder"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-api && npx jest __tests__/hermesUi.test.ts -t "profile scoping"`
Expected: FAIL (no `export HERMES_HOME` line).

- [ ] **Step 3: Implement in `hermesUi.ts`**

Add near the top imports:

```javascript
const {
  resolveHermesProfileHome,
} = require("../agent-runtime/lib/hermesRuntimeBootstrap");
```

Change `buildHermesPythonCommand`:

```javascript
function buildHermesPythonCommand(script, { profile = "default" } = {}) {
  const encoded = Buffer.from(String(script || ""), "utf8").toString("base64");
  const home = resolveHermesProfileHome(profile);
  return [
    "set -eu",
    `export HERMES_HOME="${home}"`,
    'HERMES_ROOT="/opt/hermes"',
    'HERMES_PYTHON="$HERMES_ROOT/.venv/bin/python"',
    'if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="$HERMES_ROOT/.venv/bin/python3"; fi',
    'if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="$(command -v python3 2>/dev/null || true)"; fi',
    '[ -n "$HERMES_PYTHON" ] || exit 127',
    'if [ -d "$HERMES_ROOT" ]; then cd "$HERMES_ROOT"; fi',
    'PYTHONPATH="$HERMES_ROOT${PYTHONPATH:+:$PYTHONPATH}" exec "$HERMES_PYTHON" - <<\'PY\'',
    "import base64",
    "__nora_globals = {'__name__': '__main__'}",
    `exec(base64.b64decode(${JSON.stringify(encoded)}).decode('utf-8'), __nora_globals)`,
    "PY",
  ].join("\n");
}
```

Update the two callers to forward `profile`:

```javascript
async function runHermesPython(agent, script, { timeout = 30000, profile = "default" } = {}) {
  return runContainerCommand(agent, buildHermesPythonCommand(script, { profile }), { timeout });
}

async function runHermesPythonJson(agent, script, { timeout = 30000, profile = "default" } = {}) {
  const result = await runHermesPython(agent, script, { timeout, profile });
  const raw = String(result?.output || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    const nextError = new Error(
      `Unexpected Hermes helper output: ${raw.slice(0, 400) || error.message}`,
    );
    nextError.cause = error;
    throw nextError;
  }
}
```

Export `buildHermesPythonCommand` if not already exported (it is, per the existing `module.exports`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-api && npx jest __tests__/hermesUi.test.ts -t "profile scoping"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-api/hermesUi.ts backend-api/__tests__/hermesUi.test.ts
git commit -m "feat(hermes): scope hermesUi python helpers by profile HERMES_HOME"
```

---

### Task 6: Per-`(agent, profile)` state persistence + profile-aware channel/snapshot/model/restart

**Files:**
- Modify: `backend-api/hermesUi.ts` (`getPersistedHermesState`, `replacePersistedHermesState`, `persistHermesChannelState`, `deletePersistedHermesChannelState`, `readHermesRuntimeSnapshot`, `persistHermesChannelConfig`, `removeHermesChannelConfig`, `persistHermesModelConfig`, `listHermesChannels`, `saveHermesChannel`, `deleteHermesChannel`, `testHermesChannel`, `applyPersistedHermesState`, `restartHermesRuntime`)
- Test: `backend-api/__tests__/hermesUi.test.ts`

**Interfaces:**
- Consumes: Task 5 (`profile` on python helpers), Task 3 stop/start snippets (for named-profile restart).
- Produces: every listed function accepts a trailing `profile = "default"` option/arg and filters DB reads/writes on `profile_name`. `restartHermesRuntime(agent, { profile = "default" })` restarts only the named profile's gateway (kill+relaunch via `runContainerCommand`) when `profile !== "default"`; for `default` it keeps the existing container restart.

- [ ] **Step 1: Write the failing test**

Append to `backend-api/__tests__/hermesUi.test.ts`:

```javascript
describe("per-profile state persistence", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
  });

  it("getPersistedHermesState filters by profile_name", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ model_config: "{}", channel_configs: "{}" }] });
    await getPersistedHermesState("agent-1", { profile: "coder" });
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain("profile_name = $2");
    expect(params).toEqual(["agent-1", "coder"]);
  });

  it("replacePersistedHermesState writes the profile_name", async () => {
    mockDb.query.mockResolvedValue({ rows: [] });
    await replacePersistedHermesState("agent-1", { modelConfig: {}, channels: [] }, { profile: "coder" });
    const call = mockDb.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO hermes_runtime_state"));
    expect(call[0]).toContain("profile_name");
    expect(call[1]).toContain("coder");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-api && npx jest __tests__/hermesUi.test.ts -t "per-profile state"`
Expected: FAIL.

- [ ] **Step 3: Implement in `hermesUi.ts`**

Update the two state functions (add `profile` param, thread into SQL). `getPersistedHermesState`:

```javascript
async function getPersistedHermesState(agentId, { profile = "default" } = {}) {
  const result = await db.query(
    `SELECT model_config, channel_configs
       FROM hermes_runtime_state
      WHERE agent_id = $1 AND profile_name = $2
      LIMIT 1`,
    [agentId, profile],
  );
  const row = result.rows[0];
  if (!row) {
    return { modelConfig: {}, channels: [] };
  }
  const rawChannels = decodeMaybeJson(row.channel_configs, {});
  return {
    modelConfig: normalizeHermesModelConfig(decodeMaybeJson(row.model_config, {})),
    channels: Object.entries(rawChannels)
      .map(([type, config]) => {
        const definition = definitionForChannelType(type);
        if (!definition) return null;
        return { type: definition.type, config: decryptHermesStoredChannelConfig(definition, config) };
      })
      .filter(Boolean),
  };
}
```

`replacePersistedHermesState` — add `{ profile = "default" } = {}` as a third arg and change the upsert:

```javascript
  await db.query(
    `INSERT INTO hermes_runtime_state(agent_id, profile_name, model_config, channel_configs)
     VALUES($1, $2, $3, $4)
     ON CONFLICT (agent_id, profile_name)
     DO UPDATE SET
       model_config = EXCLUDED.model_config,
       channel_configs = EXCLUDED.channel_configs,
       updated_at = NOW()`,
    [agentId, profile, JSON.stringify(normalizedModelConfig), JSON.stringify(securedChannels)],
  );
```

Thread `profile` through the callers so the profile flows end-to-end (keep default `"default"` everywhere):
- `persistHermesChannelState(agentId, type, config, { profile })` → calls `getPersistedHermesState(agentId, { profile })` and `replacePersistedHermesState(agentId, {...}, { profile })`.
- `deletePersistedHermesChannelState(agentId, type, { profile })` similarly.
- `readHermesRuntimeSnapshot(agent, { profile })` → pass `{ profile }` to `runHermesPythonJson`.
- `persistHermesChannelConfig(agent, definition, config, { profile })` and `removeHermesChannelConfig(agent, definition, { profile })` → pass `{ profile }` to `runHermesPythonJson`. (For the Kubernetes branch, throw `createProfileUnsupportedOnK8sError()` — see Task 8 — when `profile !== "default"`; keep existing behavior for `default`.)
- `persistHermesModelConfig(agent, modelConfig, { profile })` → pass `{ profile }` to `runHermesPythonJson`. (Same k8s guard for non-default.)
- `listHermesChannels(agent, { profile })`, `saveHermesChannel(agent, type, cfg, { create, profile })`, `deleteHermesChannel(agent, type, { profile })`, `testHermesChannel(agent, type, { profile })` → thread `profile` into every internal call (`readHermesRuntimeSnapshot`, `persistHermesChannelState`, `persistHermesChannelConfig`, `restartHermesRuntime`).
- `applyPersistedHermesState(agent, persistedState, { restart, profile })` → thread `profile` into the persist calls and `restartHermesRuntime`.

Change `restartHermesRuntime` to restart only a named profile's gateway:

```javascript
async function restartHermesRuntime(agent, { profile = "default" } = {}) {
  if (profile !== "default") {
    const home = resolveHermesProfileHome(profile);
    const {
      buildHermesProfileGatewayStopSnippet,
      buildHermesProfileGatewayStartSnippet,
    } = require("../agent-runtime/lib/hermesRuntimeBootstrap");
    const restartCommand = [
      "set -eu",
      `HERMES_BIN="/opt/hermes/.venv/bin/hermes"`,
      '[ -x "$HERMES_BIN" ] || HERMES_BIN="$(command -v hermes 2>/dev/null || true)"',
      buildHermesProfileGatewayStopSnippet(home),
      buildHermesProfileGatewayStartSnippet(home),
    ].join("\n");
    await runContainerCommand(agent, restartCommand, { timeout: 30000 });
    return;
  }
  // default profile: existing full-container restart (unchanged) ...
```

Keep the entire existing body of `restartHermesRuntime` as the `default` branch.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-api && npx jest __tests__/hermesUi.test.ts`
Expected: PASS (new tests + existing ones still green).

- [ ] **Step 5: Commit**

```bash
git add backend-api/hermesUi.ts backend-api/__tests__/hermesUi.test.ts
git commit -m "feat(hermes): per-profile channel/model state and named-profile gateway restart"
```

---

## Phase 4 — Profile registry & lifecycle

### Task 7: `hermesProfiles.ts` — list / create / delete / gateway lifecycle + reconciliation

**Files:**
- Create: `backend-api/hermesProfiles.ts`
- Test: `backend-api/__tests__/hermesProfiles.test.ts`

**Interfaces:**
- Consumes: `db` (`../db`), `runContainerCommand` (`../authSync`), `containerManager` (`../containerManager`), `resolveHermesProfileHome`/`isValidHermesProfileName`/`buildHermesProfileGatewayStartSnippet`/`buildHermesProfileGatewayStopSnippet` (`../agent-runtime/lib/hermesRuntimeBootstrap`).
- Produces:
  - `listHermesProfiles(agent): Promise<{ profiles: Array<{ name, displayName, isDefault, running }> }>` — union of on-disk profile dirs (+ `default`) and the `hermes_profiles` registry, with `running` from pidfile liveness (default profile always `running` when the agent is up).
  - `createHermesProfile(agent, name, { cloneFrom }): Promise<{ profile }>` — validate name (reject `default`/invalid/duplicate), `hermes profile create` (with `--clone-from` when `cloneFrom`), insert registry row, launch its gateway; returns the created profile.
  - `deleteHermesProfile(agent, name): Promise<{ profiles }>` — reject `default`; stop the gateway; `hermes profile delete <name>`; delete `hermes_profiles` + `hermes_runtime_state` rows; returns the new list.
  - `setProfileGatewayState(agent, name, action): Promise<{ profiles }>` — `action` ∈ `start|stop|restart`; reject `default` for stop/restart-as-process (default is PID 1); returns the new list.
  - `assertProfileExists(agent, name): Promise<void>` — throws `statusCode 404` if the profile is unknown; used by routes for `?profile=` validation.

- [ ] **Step 1: Write the failing test**

Create `backend-api/__tests__/hermesProfiles.test.ts`:

```javascript
// @ts-nocheck
const mockDb = { query: jest.fn() };
const mockRunContainerCommand = jest.fn();
const mockIsKubernetesAgent = jest.fn(() => false);

jest.mock("../db", () => mockDb);
jest.mock("../authSync", () => ({ runContainerCommand: mockRunContainerCommand }));
jest.mock("../containerManager", () => ({ isKubernetesAgent: mockIsKubernetesAgent }));

const {
  listHermesProfiles,
  createHermesProfile,
  deleteHermesProfile,
} = require("../hermesProfiles");

const agent = { id: "agent-1", container_id: "c1" };

beforeEach(() => {
  mockDb.query.mockReset();
  mockRunContainerCommand.mockReset();
  mockIsKubernetesAgent.mockReturnValue(false);
});

describe("createHermesProfile", () => {
  it("rejects the reserved 'default' name", async () => {
    await expect(createHermesProfile(agent, "default")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects invalid slugs", async () => {
    await expect(createHermesProfile(agent, "Bad Name")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("creates the profile via CLI, registers it, and starts its gateway", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] }) // duplicate check
      .mockResolvedValueOnce({ rows: [] }); // insert
    mockRunContainerCommand.mockResolvedValue({ output: "{}" });
    await createHermesProfile(agent, "coder");
    const commands = mockRunContainerCommand.mock.calls.map(([, cmd]) => cmd).join("\n");
    expect(commands).toContain("profile create coder");
    expect(commands).toContain("gateway run");
    const insert = mockDb.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO hermes_profiles"));
    expect(insert[1]).toEqual(expect.arrayContaining(["agent-1", "coder"]));
  });
});

describe("deleteHermesProfile", () => {
  it("refuses to delete default", async () => {
    await expect(deleteHermesProfile(agent, "default")).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("listHermesProfiles", () => {
  it("always includes default and merges on-disk + registry", async () => {
    // on-disk enumeration returns coder; registry has coder + davids-pa (davids-pa off-disk)
    mockRunContainerCommand.mockResolvedValue({
      output: JSON.stringify({ profiles: [{ name: "coder", running: true }] }),
    });
    mockDb.query.mockResolvedValue({
      rows: [{ name: "coder", display_name: "Coder", is_default: false }],
    });
    const { profiles } = await listHermesProfiles(agent);
    const names = profiles.map((p) => p.name).sort();
    expect(names).toContain("default");
    expect(names).toContain("coder");
    expect(profiles.find((p) => p.name === "default").isDefault).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-api && npx jest __tests__/hermesProfiles.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `backend-api/hermesProfiles.ts`**

```javascript
// @ts-nocheck
const db = require("./db");
const { runContainerCommand } = require("./authSync");
const containerManager = require("./containerManager");
const {
  isValidHermesProfileName,
  resolveHermesProfileHome,
  buildHermesProfileGatewayStartSnippet,
  buildHermesProfileGatewayStopSnippet,
} = require("../agent-runtime/lib/hermesRuntimeBootstrap");

const HERMES_BIN_PREAMBLE = [
  'HERMES_BIN="/opt/hermes/.venv/bin/hermes"',
  '[ -x "$HERMES_BIN" ] || HERMES_BIN="$(command -v hermes 2>/dev/null || true)"',
].join("\n");

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertProfileManagementSupported(agent) {
  if (typeof containerManager.isKubernetesAgent === "function" && containerManager.isKubernetesAgent(agent)) {
    throw statusError("Hermes profile management is not supported on Kubernetes agents yet", 409);
  }
}

// Enumerate on-disk profiles + pidfile liveness via a tiny shell probe.
async function readOnDiskProfiles(agent) {
  const command = [
    "set -eu",
    'root="/opt/data/profiles"',
    'first=1',
    'printf "{\\"profiles\\":["',
    'if [ -d "$root" ]; then',
    '  for d in "$root"/*/; do',
    '    [ -d "$d" ] || continue',
    '    name="$(basename "$d")"',
    '    running=false',
    '    if [ -f "$d/gateway.pid" ] && kill -0 "$(cat "$d/gateway.pid")" 2>/dev/null; then running=true; fi',
    '    if [ "$first" -eq 0 ]; then printf ","; fi',
    '    printf "{\\"name\\":\\"%s\\",\\"running\\":%s}" "$name" "$running"',
    '    first=0',
    '  done',
    "fi",
    'printf "]}"',
  ].join("\n");
  const result = await runContainerCommand(agent, command, { timeout: 15000 });
  try {
    return JSON.parse(String(result?.output || "").trim() || '{"profiles":[]}');
  } catch {
    return { profiles: [] };
  }
}

async function listHermesProfiles(agent) {
  const [onDisk, registry] = await Promise.all([
    readOnDiskProfiles(agent),
    db.query(
      "SELECT name, display_name, is_default FROM hermes_profiles WHERE agent_id = $1",
      [agent.id],
    ),
  ]);

  const byName = new Map();
  byName.set("default", { name: "default", displayName: "Default", isDefault: true, running: true });

  for (const row of registry.rows || []) {
    byName.set(row.name, {
      name: row.name,
      displayName: row.display_name || row.name,
      isDefault: Boolean(row.is_default),
      running: row.name === "default",
    });
  }
  for (const p of onDisk.profiles || []) {
    const existing = byName.get(p.name) || { name: p.name, displayName: p.name, isDefault: false };
    byName.set(p.name, { ...existing, running: Boolean(p.running) });
    // Auto-register out-of-band profiles Nora didn't create.
    if (!(registry.rows || []).some((r) => r.name === p.name)) {
      await db.query(
        `INSERT INTO hermes_profiles(agent_id, name, display_name, is_default)
         VALUES($1, $2, $2, FALSE) ON CONFLICT (agent_id, name) DO NOTHING`,
        [agent.id, p.name],
      );
    }
  }

  return { profiles: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

async function assertProfileExists(agent, name) {
  if (name === "default") return;
  const { profiles } = await listHermesProfiles(agent);
  if (!profiles.some((p) => p.name === name)) {
    throw statusError(`Unknown Hermes profile: ${name}`, 404);
  }
}

async function createHermesProfile(agent, name, { cloneFrom } = {}) {
  assertProfileManagementSupported(agent);
  if (name === "default") throw statusError("'default' is reserved", 400);
  if (!isValidHermesProfileName(name)) throw statusError(`Invalid profile name: ${name}`, 400);

  const dup = await db.query(
    "SELECT 1 FROM hermes_profiles WHERE agent_id = $1 AND name = $2",
    [agent.id, name],
  );
  if (dup.rows[0]) throw statusError(`Profile ${name} already exists`, 409);

  const cloneArg = cloneFrom && isValidHermesProfileName(cloneFrom) && cloneFrom !== "default"
    ? ` --clone-from ${cloneFrom}`
    : "";
  const home = resolveHermesProfileHome(name);
  const command = [
    "set -eu",
    HERMES_BIN_PREAMBLE,
    `"$HERMES_BIN" profile create ${name}${cloneArg}`,
    buildHermesProfileGatewayStartSnippet(home),
  ].join("\n");
  await runContainerCommand(agent, command, { timeout: 60000 });

  await db.query(
    `INSERT INTO hermes_profiles(agent_id, name, display_name, is_default)
     VALUES($1, $2, $2, FALSE) ON CONFLICT (agent_id, name) DO NOTHING`,
    [agent.id, name],
  );

  return { profile: { name, displayName: name, isDefault: false, running: true } };
}

async function deleteHermesProfile(agent, name) {
  assertProfileManagementSupported(agent);
  if (name === "default") throw statusError("The default profile cannot be deleted", 400);
  if (!isValidHermesProfileName(name)) throw statusError(`Invalid profile name: ${name}`, 400);

  const home = resolveHermesProfileHome(name);
  const command = [
    "set -eu",
    HERMES_BIN_PREAMBLE,
    buildHermesProfileGatewayStopSnippet(home),
    `"$HERMES_BIN" profile delete ${name} --yes 2>/dev/null || "$HERMES_BIN" profile delete ${name} || true`,
  ].join("\n");
  await runContainerCommand(agent, command, { timeout: 60000 });

  await db.query("DELETE FROM hermes_runtime_state WHERE agent_id = $1 AND profile_name = $2", [agent.id, name]);
  await db.query("DELETE FROM hermes_profiles WHERE agent_id = $1 AND name = $2", [agent.id, name]);

  return listHermesProfiles(agent);
}

async function setProfileGatewayState(agent, name, action) {
  assertProfileManagementSupported(agent);
  if (name === "default") throw statusError("The default profile gateway is managed by the runtime", 400);
  await assertProfileExists(agent, name);
  const home = resolveHermesProfileHome(name);
  const parts = ["set -eu", HERMES_BIN_PREAMBLE];
  if (action === "stop" || action === "restart") parts.push(buildHermesProfileGatewayStopSnippet(home));
  if (action === "start" || action === "restart") parts.push(buildHermesProfileGatewayStartSnippet(home));
  if (parts.length === 2) throw statusError(`Unknown gateway action: ${action}`, 400);
  await runContainerCommand(agent, parts.join("\n"), { timeout: 30000 });
  return listHermesProfiles(agent);
}

module.exports = {
  listHermesProfiles,
  createHermesProfile,
  deleteHermesProfile,
  setProfileGatewayState,
  assertProfileExists,
  assertProfileManagementSupported,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-api && npx jest __tests__/hermesProfiles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-api/hermesProfiles.ts backend-api/__tests__/hermesProfiles.test.ts
git commit -m "feat(hermes): profile registry + lifecycle helpers (list/create/delete/gateway)"
```

---

## Phase 5 — Backend routes

### Task 8: Profile routes + `?profile=` on existing hermes-ui routes

**Files:**
- Modify: `backend-api/routes/agents.ts` (add profile routes near the other `/:id/hermes-ui/*` routes ~1162-1699; add `?profile=` resolution to channel/cron/status routes)
- Test: `backend-api/__tests__/hermesProfilesRoutes.test.ts` (create) — follow the supertest/express pattern used by `agentMigrationsRoutes.test.ts`

**Interfaces:**
- Consumes: `loadHermesUiAgent` (agents.ts:837), `hermesProfiles.ts` (Task 7), profile-aware `hermesUi.ts` functions (Task 6).
- Produces routes:
  - `GET  /:id/hermes-ui/profiles`
  - `POST /:id/hermes-ui/profiles` — body `{ name, cloneFrom? }`
  - `DELETE /:id/hermes-ui/profiles/:name`
  - `POST /:id/hermes-ui/profiles/:name/gateway` — body `{ action }`
  - existing `GET/POST/PATCH/DELETE /:id/hermes-ui/channels...` accept `?profile=<name>` (default `default`), validated via `assertProfileExists`. **Cron and Chat routes are NOT profile-scoped** — they proxy the runtime API server (`fetchHermesApi`), which named-profile gateways don't run, so they stay default-only in v1.

- [ ] **Step 1: Write the failing test**

Create `backend-api/__tests__/hermesProfilesRoutes.test.ts` mirroring `agentMigrationsRoutes.test.ts`'s harness (mock `loadHermesUiAgent`/auth as that file does; mock `../hermesProfiles`). Minimum assertions:

```javascript
// @ts-nocheck
const request = require("supertest");
// ... reuse the express app + auth mock bootstrap from agentMigrationsRoutes.test.ts ...
const mockListHermesProfiles = jest.fn();
const mockCreateHermesProfile = jest.fn();
jest.mock("../hermesProfiles", () => ({
  listHermesProfiles: (...a) => mockListHermesProfiles(...a),
  createHermesProfile: (...a) => mockCreateHermesProfile(...a),
  deleteHermesProfile: jest.fn(),
  setProfileGatewayState: jest.fn(),
  assertProfileExists: jest.fn(),
  assertProfileManagementSupported: jest.fn(),
}));

describe("hermes profile routes", () => {
  it("GET /:id/hermes-ui/profiles returns the profile list", async () => {
    mockListHermesProfiles.mockResolvedValue({ profiles: [{ name: "default", isDefault: true, running: true }] });
    const res = await request(app).get("/agents/agent-1/hermes-ui/profiles").set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.profiles[0].name).toBe("default");
  });

  it("POST /:id/hermes-ui/profiles creates a profile", async () => {
    mockCreateHermesProfile.mockResolvedValue({ profile: { name: "coder" } });
    const res = await request(app).post("/agents/agent-1/hermes-ui/profiles").set(authHeader).send({ name: "coder" });
    expect(res.status).toBe(200);
    expect(mockCreateHermesProfile).toHaveBeenCalledWith(expect.anything(), "coder", { cloneFrom: undefined });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-api && npx jest __tests__/hermesProfilesRoutes.test.ts`
Expected: FAIL (routes 404).

- [ ] **Step 3: Implement the routes in `agents.ts`**

Add to the `require("../hermesProfiles")` (create the import) and add a small helper to resolve+validate the query profile:

```javascript
const {
  listHermesProfiles,
  createHermesProfile,
  deleteHermesProfile,
  setProfileGatewayState,
  assertProfileExists,
} = require("../hermesProfiles");

async function resolveHermesProfileParam(agent, req) {
  const raw = typeof req.query?.profile === "string" ? req.query.profile.trim() : "";
  const profile = raw || "default";
  await assertProfileExists(agent, profile);
  return profile;
}
```

Add the profile routes (place them just before the existing `/:id/hermes-ui/channels` block):

```javascript
router.get(
  "/:id/hermes-ui/profiles",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req);
    try {
      res.json(await listHermesProfiles(agent));
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || "Failed to list Hermes profiles" });
    }
  }),
);

router.post(
  "/:id/hermes-ui/profiles",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req, { requiredRole: "editor" });
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const cloneFrom = typeof req.body?.cloneFrom === "string" && req.body.cloneFrom.trim()
      ? req.body.cloneFrom.trim() : undefined;
    try {
      res.json(await createHermesProfile(agent, name, { cloneFrom }));
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || "Failed to create Hermes profile" });
    }
  }),
);

router.delete(
  "/:id/hermes-ui/profiles/:name",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req, { requiredRole: "editor" });
    try {
      res.json(await deleteHermesProfile(agent, req.params.name));
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || "Failed to delete Hermes profile" });
    }
  }),
);

router.post(
  "/:id/hermes-ui/profiles/:name/gateway",
  asyncHandler(async (req, res) => {
    const agent = await loadHermesUiAgent(req, { requiredRole: "editor" });
    const action = typeof req.body?.action === "string" ? req.body.action.trim() : "";
    try {
      res.json(await setProfileGatewayState(agent, req.params.name, action));
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message || "Failed to change gateway state" });
    }
  }),
);
```

Then thread the profile into the **channel** handlers only. For each, after `loadHermesUiAgent`, add `const profile = await resolveHermesProfileParam(agent, req);` and pass `{ profile }` into the corresponding `hermesUi` call:
- `GET /:id/hermes-ui/channels` → `listHermesChannels(agent, { profile })`
- `POST /:id/hermes-ui/channels` → `saveHermesChannel(agent, type, resolveHermesChannelConfig(req.body), { create: true, profile })`
- `PATCH /:id/hermes-ui/channels/:channelId` → `saveHermesChannel(agent, req.params.channelId, resolveHermesChannelConfig(req.body), { profile })`
- `DELETE /:id/hermes-ui/channels/:channelId` → `deleteHermesChannel(agent, req.params.channelId, { profile })`
- `POST /:id/hermes-ui/channels/:channelId/test` → `testHermesChannel(agent, req.params.channelId, { profile })`

Do **not** add `?profile=` to the cron routes or the `GET /:id/hermes-ui` snapshot: they proxy the runtime API server (default profile only in v1). Leave them exactly as they are.

(`saveHermesChannel`'s signature from Task 6 is `(agent, type, cfg, { create = false, profile = "default" } = {})`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-api && npx jest __tests__/hermesProfilesRoutes.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full hermes backend test suite (no regressions)**

Run: `cd backend-api && npx jest __tests__/hermesUi.test.ts __tests__/hermesProfiles.test.ts __tests__/hermesProfilesRoutes.test.ts __tests__/remoteHermes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend-api/routes/agents.ts backend-api/__tests__/hermesProfilesRoutes.test.ts
git commit -m "feat(hermes): profile CRUD routes + ?profile= scoping on hermes-ui routes"
```

---

## Phase 6 — Frontend

### Task 9: `ProfileSwitcher` component

**Files:**
- Create: `frontend-dashboard/components/agents/hermes/ProfileSwitcher.tsx`

**Interfaces:**
- Consumes: `fetchWithAuth` (`../../../lib/api`), `GET/POST/DELETE /api/agents/:id/hermes-ui/profiles`.
- Produces (default export): `ProfileSwitcher({ agentId, selectedProfile, onSelect, disabled })` — renders a dropdown of profiles with a running/stopped dot, a "New profile" inline create (name + optional clone-from), and a delete button for non-default profiles. Calls `onSelect(name)` on change. When `disabled` (e.g. k8s), renders nothing.

- [ ] **Step 1: Implement the component**

```jsx
import { useEffect, useState } from "react";
import { Plus, Trash2, ChevronDown } from "lucide-react";
import { fetchWithAuth } from "../../../lib/api";

export default function ProfileSwitcher({ agentId, selectedProfile, onSelect, disabled }) {
  const [profiles, setProfiles] = useState([{ name: "default", isDefault: true, running: true }]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/profiles`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.profiles)) setProfiles(data.profiles);
    } catch {
      /* keep last known list */
    }
  }

  useEffect(() => {
    if (agentId && !disabled) load();
  }, [agentId, disabled]);

  async function createProfile() {
    setError("");
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/profiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to create profile");
      setNewName("");
      setCreating(false);
      await load();
      if (data.profile?.name) onSelect(data.profile.name);
    } catch (e) {
      setError(e.message);
    }
  }

  async function deleteProfile(name) {
    if (!window.confirm(`Delete Hermes profile "${name}"? This removes its config and gateway.`)) return;
    const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/profiles/${name}`, { method: "DELETE" });
    if (res.ok) {
      if (selectedProfile === name) onSelect("default");
      await load();
    }
  }

  if (disabled) return null;

  const current = profiles.find((p) => p.name === selectedProfile) || profiles[0];

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <select
          value={selectedProfile}
          onChange={(e) => onSelect(e.target.value)}
          className="appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pl-3 pr-8 text-xs font-bold text-slate-700"
        >
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.displayName || p.name}{p.running ? " ●" : " ○"}
            </option>
          ))}
        </select>
        <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
      </div>

      {current && !current.isDefault && (
        <button onClick={() => deleteProfile(current.name)} className="text-slate-400 hover:text-red-500" title="Delete profile">
          <Trash2 size={14} />
        </button>
      )}

      {creating ? (
        <span className="flex items-center gap-1">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="profile-name"
            className="w-32 rounded-lg border border-slate-200 px-2 py-1 text-xs"
          />
          <button onClick={createProfile} className="rounded-lg bg-blue-600 px-2 py-1 text-xs font-bold text-white">Create</button>
          <button onClick={() => { setCreating(false); setError(""); }} className="text-xs text-slate-400">Cancel</button>
        </span>
      ) : (
        <button onClick={() => setCreating(true)} className="flex items-center gap-1 text-xs font-bold text-blue-600" title="New profile">
          <Plus size={14} /> Profile
        </button>
      )}
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
```

- [ ] **Step 2: Build the dashboard to typecheck/compile the new component**

Run: `cd frontend-dashboard && npm run build`
Expected: build succeeds (no import/JSX errors from `ProfileSwitcher.tsx`).

- [ ] **Step 3: Commit**

```bash
git add frontend-dashboard/components/agents/hermes/ProfileSwitcher.tsx
git commit -m "feat(hermes): profile switcher component"
```

---

### Task 10: Mount the switcher and scope the Channels panel by profile

**Files:**
- Modify: `frontend-dashboard/components/agents/HermesWebUITab.tsx`
- Modify: `frontend-dashboard/components/agents/hermes/ChannelsPanel.tsx`

**Interfaces:**
- Consumes: `ProfileSwitcher` (Task 9); backend channel `?profile=` routes (Task 8).
- Produces: `HermesWebUITab` holds `selectedProfile` (default `"default"`), renders `ProfileSwitcher` above the sub-tab bar (hidden when the agent is a k8s Hermes agent — pass `disabled={runtimeInfo?.deployTarget === "k8s"}` if that field exists on `runtimeInfo`, else omit), passes `profile={selectedProfile}` to `ChannelsPanel`, and shows a "default-only in v1" banner on the Cron/Chat/Status sub-tabs when `selectedProfile !== "default"`. `ChannelsPanel` appends `?profile=<profile>` to its hermes-ui fetches. The Cron/Chat/Status/Official-Dashboard panels are otherwise unchanged.

- [ ] **Step 1: Update `HermesWebUITab.tsx`**

Add the import and state, render the switcher, and pass the prop:

```jsx
import ProfileSwitcher from "./hermes/ProfileSwitcher";
// ...
const [selectedProfile, setSelectedProfile] = useState("default");
// reset on agent change (next to the existing setActiveSubTab reset):
useEffect(() => { setSelectedProfile("default"); }, [agentId]);
```

Above the sub-tab bar container (inside the returned JSX, before the `subTabs.map` wrapper):

```jsx
<div className="flex items-center justify-between gap-2">
  <ProfileSwitcher
    agentId={agentId}
    selectedProfile={selectedProfile}
    onSelect={setSelectedProfile}
    disabled={runtimeInfo?.deployTarget === "k8s"}
  />
</div>
```

Pass `profile={selectedProfile}` to `ChannelsPanel` only. For the Cron/Chat/Status sub-tabs, render a banner above the panel when a non-default profile is selected (they still show default-profile data):

```jsx
{selectedProfile !== "default" && ["status", "chat", "cron"].includes(activeSubTab) && (
  <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
    Cron, Chat, and Status are managed on the <strong>default</strong> profile. For the
    “{selectedProfile}” profile, use the Official Dashboard’s built-in profile switcher.
  </div>
)}
{activeSubTab === "status" && (
  <HermesStatusPanel agentId={agentId} runtimeInfo={runtimeInfo} loading={loading} error={error} onRefresh={() => loadRuntimeInfo({ showSpinner: false })} />
)}
{activeSubTab === "chat" && (
  <HermesChatPanel agentId={agentId} runtimeInfo={runtimeInfo} loadingRuntime={loading} runtimeError={error} onRefreshRuntime={() => loadRuntimeInfo({ showSpinner: false })} />
)}
{activeSubTab === "cron" && <HermesCronPanel agentId={agentId} />}
{activeSubTab === "channels" && <HermesChannelsPanel agentId={agentId} profile={selectedProfile} />}
```

(`StatusPanel`, `ChatPanel`, `CronPanel` keep their existing props — they are not profile-scoped in v1.)

- [ ] **Step 2: Thread `profile` into `ChannelsPanel`'s fetches**

In `ChannelsPanel.tsx`: change the signature to `HermesChannelsPanel({ agentId, profile = "default" })` and append the query param to every `/api/agents/${agentId}/hermes-ui/channels...` URL. Add a helper at the top of the file:

```jsx
const withProfile = (url, profile) => `${url}${url.includes("?") ? "&" : "?"}profile=${encodeURIComponent(profile || "default")}`;
```

Then wrap each channels fetch URL — the GET load, the POST/PATCH save (`/hermes-ui/channels` and `/hermes-ui/channels/${selectedType}`), the DELETE (`/hermes-ui/channels/${channel.type}`), and the test (`/hermes-ui/channels/${channel.type}/test`):

```jsx
const res = await fetchWithAuth(withProfile(`/api/agents/${agentId}/hermes-ui/channels`, profile));
```

Add `profile` to the `useEffect` dependency array that triggers the channels reload so switching profiles refetches.

- [ ] **Step 3: Build to verify compilation**

Run: `cd frontend-dashboard && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend-dashboard/components/agents/HermesWebUITab.tsx frontend-dashboard/components/agents/hermes/ChannelsPanel.tsx
git commit -m "feat(hermes): dashboard profile switcher + per-profile channels"
```

---

## Phase 7 — End-to-end verification

### Task 11: E2E smoke — create a profile, scope a channel, confirm isolation

**Files:**
- Create: `e2e/specs/hermes-profiles.spec.ts` (follow the structure of an existing Hermes/real-deploy spec such as `e2e/specs/real-deploy-matrix.spec.ts`; gate it behind the same real-deploy env flag those specs use so it only runs when a live stack + Hermes image are available)

**Interfaces:**
- Consumes: the running stack (`docker compose up -d`), a deployed local Docker Hermes agent, the backend profile routes.

- [ ] **Step 1: Write the smoke spec**

The spec should, against a running Hermes agent: (a) `POST /api/agents/:id/hermes-ui/profiles {name:"smoke"}` and expect 200; (b) `GET .../profiles` and assert both `default` and `smoke` appear, `default.isDefault === true`; (c) `POST .../channels?profile=smoke` configuring a Telegram bot token, expect 200; (d) `GET .../channels?profile=smoke` shows the channel configured; (e) `GET .../channels?profile=default` does NOT show it (isolation); (f) `DELETE .../profiles/smoke` and confirm it's gone from `GET .../profiles`.

Use the spec file's existing auth/bootstrap helpers (see `e2e/specs/support/agents.ts` and `support/realConfig.ts`) for logging in, deploying a Hermes agent, and issuing authenticated API calls.

- [ ] **Step 2: Run the smoke test against a live stack**

Run:
```bash
docker compose up -d --build
cd e2e && npm ci && npx playwright install --with-deps chromium
npx playwright test specs/hermes-profiles.spec.ts
```
Expected: PASS (profile created, channel scoped to `smoke`, absent from `default`, profile deleted).

- [ ] **Step 3: Commit**

```bash
git add e2e/specs/hermes-profiles.spec.ts
git commit -m "test(hermes): e2e smoke for multi-profile create/scope/isolation"
```

---

## Final verification

- [ ] **Backend unit suite:** `cd backend-api && npm test` → all green.
- [ ] **agent-runtime suite:** `cd agent-runtime && npx vitest run` → all green.
- [ ] **Frontend build:** `cd frontend-dashboard && npm run build` → succeeds.
- [ ] **Shared blast-radius check:** confirm `workers/provisioner/backends/hermes.ts` and `agent-runtime/lib/hermesRuntimeBootstrap.ts` still load in both backend-api and the worker (`node -e "require('...')"` from each service root).
- [ ] **Docs:** update the Hermes section of `CLAUDE.md` / nearest architecture doc to note that a Hermes agent now hosts multiple profiles (default at `/opt/data`, named under `/opt/data/profiles/<name>`, concurrent gateways, Nora profile selector), per the repo Maintenance Rule.

## Notes on scope boundaries (from the spec)

- **Model config per profile:** the data model stores `model_config` per `(agent, profile)` and `persistHermesModelConfig`/`applyPersistedHermesState` accept a `profile`. The existing LLM-setup/auth-reseed path in `authSync.ts` continues to target the **default** profile only in v1 (it reseeds the container-managed env / default config). Named profiles get their model config applied via the profile-scoped exec path. Wiring the LLM wizard to pick a target profile is a deliberate follow-up.
- **Cron & Chat are default-only in v1:** these routes proxy the Hermes runtime **API server** (`fetchHermesApi`), and named-profile gateways run with `API_SERVER_ENABLED=false` (Key decision 3 — no extra ports). The profile's cron jobs still *execute* (the scheduler lives in the gateway); only *managing* them from Nora is default-only. Named-profile cron/chat are handled via the official WebUI's native switcher. Making these per-profile in Nora would require per-profile API servers + reachable ports (bigger change, deferred).
- **Kubernetes & Proxmox Hermes:** profile management rejects k8s agents (`assertProfileManagementSupported`) and the frontend hides the switcher; Proxmox Hermes is untouched. Both are out of scope for v1.
- **remote-hermes:** works unchanged because `RemoteHermesBackend extends HermesBackend` and all profile operations go through `runContainerCommand` (docker exec over SSH). No per-profile host ports are published.
