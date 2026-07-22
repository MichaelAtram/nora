# Authenticated Hermes Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Hermes agent Web UI open again by adopting Hermes's fail-closed `basic_auth` dashboard provider with a per-agent derived credential, logged in server-side by Nora's embed proxy.

**Architecture:** A shared runtime helper derives a deterministic `{username, password, secret}` from each agent's existing `API_SERVER_KEY`. Provisioner backends bake those into the container env (surviving s6 restarts) and launch the dashboard without `--insecure`. The backend-api embed proxy re-derives the same credential and performs a server-side login, relaying the Hermes session cookie upstream so the operator's iframe loads authenticated. The dashboard port stays reachable only through Nora's already-authenticated proxy.

**Tech Stack:** Node 24 (CommonJS), Express, dockerode; agent-runtime tests use **vitest**, backend-api tests use **jest**; `crypto` HMAC-SHA256 for derivation; undici `fetch` (`getSetCookie()`) in the proxy.

**Spec:** `docs/superpowers/specs/2026-07-22-hermes-dashboard-auth-design.md`

**Coverage boundary (per "mirror" scope):** The Docker backend is tested end-to-end. k8s and proxmox receive the identical edits plus a regression run of their existing suites; their shared credential logic is covered by the Task 1 unit test and validated live in Task 9. No new k8s/proxmox API-mock harnesses are built.

---

## File Structure

- `agent-runtime/lib/hermesDashboardAuth.ts` — **create.** Pure, dependency-free credential derivation shared by worker + backend-api. `module.exports` CommonJS.
- `agent-runtime/__tests__/hermesDashboardAuth.test.ts` — **create.** vitest unit test.
- `workers/provisioner/backends/hermes.ts` — **modify.** Derive + inject env; drop `--insecure`.
- `workers/provisioner/backends/k8s.ts` — **modify.** Same env injection; drop `--insecure`.
- `workers/provisioner/backends/proxmox.ts` — **modify.** Same env injection; drop `--insecure`.
- `backend-api/routes/agents.ts` — **modify.** Dashboard-restart command drops `--insecure`.
- `backend-api/hermesDashboardSession.ts` — **create.** Server-side login helper + `needsHermesLogin` predicate (isolated so it's unit-testable without booting the server).
- `backend-api/__tests__/hermesDashboardSession.test.ts` — **create.** jest unit test (mocked fetch).
- `backend-api/server.ts` — **modify.** Wire the login helper into `proxyEmbeddedHermes`.
- `backend-api/__tests__/provisioning.test.ts` — **modify.** Extend the existing Hermes provisioning test.
- `docs/configuration/environment-variables.mdx`, `docs/configuration/provisioner-backends/proxmox.mdx` — **modify.** Update the "unauthenticated dashboard" wording.

---

## Task 1: Shared credential-derivation helper

**Files:**
- Create: `agent-runtime/lib/hermesDashboardAuth.ts`
- Test: `agent-runtime/__tests__/hermesDashboardAuth.test.ts`

- [ ] **Step 1: Install agent-runtime dev deps (once)**

Run: `cd agent-runtime && npm install`
Expected: completes; `agent-runtime/node_modules/vitest` now exists.

- [ ] **Step 2: Write the failing test**

Create `agent-runtime/__tests__/hermesDashboardAuth.test.ts` (mirrors the vitest import style of `contracts.test.ts`):

```ts
import { describe, expect, it } from "vitest";

import * as dashboardAuth from "../lib/hermesDashboardAuth.ts";

const { HERMES_DASHBOARD_USERNAME, deriveHermesDashboardBasicAuth } = dashboardAuth;

describe("deriveHermesDashboardBasicAuth", () => {
  it("is deterministic for a given seed", () => {
    expect(deriveHermesDashboardBasicAuth("seed-123")).toEqual(
      deriveHermesDashboardBasicAuth("seed-123"),
    );
  });

  it("returns the fixed username and 64-char hex password/secret", () => {
    const creds = deriveHermesDashboardBasicAuth("seed-123");
    expect(creds.username).toBe(HERMES_DASHBOARD_USERNAME);
    expect(creds.password).toMatch(/^[0-9a-f]{64}$/);
    expect(creds.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses distinct labels so password and secret differ", () => {
    const creds = deriveHermesDashboardBasicAuth("seed-123");
    expect(creds.password).not.toBe(creds.secret);
  });

  it("varies by seed", () => {
    expect(deriveHermesDashboardBasicAuth("a").password).not.toBe(
      deriveHermesDashboardBasicAuth("b").password,
    );
  });

  it("rejects an empty seed", () => {
    expect(() => deriveHermesDashboardBasicAuth("")).toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd agent-runtime && npx vitest run __tests__/hermesDashboardAuth.test.ts`
Expected: FAIL — cannot resolve `../lib/hermesDashboardAuth.ts`.

- [ ] **Step 4: Write the implementation**

Create `agent-runtime/lib/hermesDashboardAuth.ts`:

```ts
// @ts-nocheck
const crypto = require("crypto");

// Fixed dashboard login username for Nora-managed Hermes agents. The password
// and token-signing secret are derived per-agent so both the worker (which
// injects them into the container env) and the backend-api embed proxy (which
// logs in on the operator's behalf) compute identical values from the same
// seed with no shared persisted state.
const HERMES_DASHBOARD_USERNAME = "nora";

function hmacHex(seed, label) {
  return crypto.createHmac("sha256", String(seed)).update(String(label)).digest("hex");
}

// Derive the Hermes dashboard basic-auth credential from a per-agent seed (the
// agent's API_SERVER_KEY / gatewayToken). Deterministic: the injected credential
// and the proxy's login credential always match, including across supervised
// restarts, because both sides re-derive from the same seed.
function deriveHermesDashboardBasicAuth(seed) {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new Error("deriveHermesDashboardBasicAuth requires a non-empty string seed");
  }
  return {
    username: HERMES_DASHBOARD_USERNAME,
    password: hmacHex(seed, "hermes-dashboard-password"),
    secret: hmacHex(seed, "hermes-dashboard-secret"),
  };
}

module.exports = {
  HERMES_DASHBOARD_USERNAME,
  deriveHermesDashboardBasicAuth,
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd agent-runtime && npx vitest run __tests__/hermesDashboardAuth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add agent-runtime/lib/hermesDashboardAuth.ts agent-runtime/__tests__/hermesDashboardAuth.test.ts
git commit -m "feat: shared Hermes dashboard basic-auth credential derivation"
```

---

## Task 2: Docker backend — inject basic-auth env + drop `--insecure`

**Files:**
- Modify: `workers/provisioner/backends/hermes.ts` (import ~line 16-18; `buildHermesStartCommand` line ~50-66; `create()` env array ~line 209-225)
- Test: `backend-api/__tests__/provisioning.test.ts` (the `Hermes dashboard provisioning` test, ~line 1783-1884)

- [ ] **Step 1: Update the test to encode the new behavior**

In `backend-api/__tests__/provisioning.test.ts`, inside the `starts the official Hermes dashboard alongside the gateway` test:

(a) Replace the dashboard `nohup` assertion (currently asserts `--insecure --no-open`):

```js
    expect(config.Cmd[2]).toContain(
      'nohup "$HERMES_BIN" dashboard --host 0.0.0.0 --no-open',
    );
    expect(config.Cmd[2]).not.toContain("--insecure");
```

(b) After the existing `API_SERVER_KEY` env assertion block, add:

```js
    // Dashboard basic-auth credential is baked into the container env and must
    // match what the proxy re-derives from the returned gateway token.
    const derivedDash = require("../../agent-runtime/lib/hermesDashboardAuth")
      .deriveHermesDashboardBasicAuth(result.gatewayToken);
    expect(config.Env).toEqual(
      expect.arrayContaining([
        `HERMES_DASHBOARD_BASIC_AUTH_USERNAME=${derivedDash.username}`,
        `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=${derivedDash.password}`,
        `HERMES_DASHBOARD_BASIC_AUTH_SECRET=${derivedDash.secret}`,
      ]),
    );
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-api && npx jest __tests__/provisioning.test.ts -t "Hermes dashboard provisioning"`
Expected: FAIL — `--insecure` still present / basic-auth env vars missing.

- [ ] **Step 3: Add the derive-helper import**

In `workers/provisioner/backends/hermes.ts`, after the `hermesRuntimeBootstrap` require (~line 16-18) add:

```js
const {
  deriveHermesDashboardBasicAuth,
} = require("../../../agent-runtime/lib/hermesDashboardAuth");
```

- [ ] **Step 4: Drop `--insecure` from the dashboard launch**

In `buildHermesStartCommand()`, change the dashboard line to:

```js
    `nohup "$HERMES_BIN" dashboard --host 0.0.0.0 --no-open >> ${HERMES_DASHBOARD_LOG} 2>&1 &`,
```

- [ ] **Step 5: Derive + inject the basic-auth env**

In `create()`, immediately after `const apiServerKey = crypto.randomBytes(32).toString("hex");` add:

```js
    const dashboardAuth = deriveHermesDashboardBasicAuth(apiServerKey);
```

Then inside the `envArray` object literal, after the `API_SERVER_KEY: apiServerKey,` block, add:

```js
      // Hermes fail-closed dashboard auth (basic-auth provider). Baked into the
      // container env so the s6-supervised dashboard reads it from
      // /run/s6/container_environment on every boot. The backend-api embed proxy
      // re-derives the identical credential from API_SERVER_KEY to log in on the
      // operator's behalf.
      HERMES_DASHBOARD_BASIC_AUTH_USERNAME: dashboardAuth.username,
      HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: dashboardAuth.password,
      HERMES_DASHBOARD_BASIC_AUTH_SECRET: dashboardAuth.secret,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend-api && npx jest __tests__/provisioning.test.ts -t "Hermes dashboard provisioning"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add workers/provisioner/backends/hermes.ts backend-api/__tests__/provisioning.test.ts
git commit -m "feat: authenticated Hermes dashboard on Docker backend"
```

---

## Task 3: Verify the Hermes login contract against the running image (Docker gate)

This task discovers the exact login endpoint, form fields, and session-cookie name that Task 4 relays. It is investigation, not code. **Requires Docker running.** If Docker is unavailable, skip to the Task 4 fallback note.

- [ ] **Step 1: Pull the image and read the dashboard CLI help**

```bash
docker pull nousresearch/hermes-agent:latest
docker run --rm nousresearch/hermes-agent:latest hermes dashboard --help
```

- [ ] **Step 2: Run a dashboard with basic-auth and probe the login flow**

```bash
docker run -d --name hermes-probe \
  -e HERMES_DASHBOARD_BASIC_AUTH_USERNAME=nora \
  -e HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=testpw \
  -e HERMES_DASHBOARD_BASIC_AUTH_SECRET="$(openssl rand -base64 32)" \
  -p 9119:9119 nousresearch/hermes-agent:latest \
  bash -lc 'hermes dashboard --host 0.0.0.0 --port 9119 --no-open'
sleep 5
curl -sS -i http://127.0.0.1:9119/ | head -30                 # expect 401 or 302 -> login
curl -sS -i http://127.0.0.1:9119/login | sed -n '1,40p'      # login page / form fields
curl -sS -i -c cookies.txt -X POST http://127.0.0.1:9119/login \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'username=nora&password=testpw'                       # capture Set-Cookie
cat cookies.txt                                                # session cookie name(s)
curl -sS -i -b cookies.txt http://127.0.0.1:9119/ | head -20  # confirm authenticated
docker rm -f hermes-probe
```

- [ ] **Step 2b: (safety) Confirm `--insecure` alone no longer serves an unauthenticated non-loopback dashboard**

```bash
docker run -d --name hermes-insecure -p 9120:9119 nousresearch/hermes-agent:latest \
  bash -lc 'hermes dashboard --host 0.0.0.0 --port 9119 --insecure --no-open'
sleep 5
docker logs hermes-insecure 2>&1 | tail -20   # note refuse-to-bind / deprecation warning
curl -sS -i http://127.0.0.1:9120/ | head -10
docker rm -f hermes-insecure
```

- [ ] **Step 3: Record findings in the plan**

Write the observed values below (edit this file), then use them in Task 4:
- Login path (default assumed): `/login`
- HTTP method / content-type (default assumed): `POST` / `application/x-www-form-urlencoded`
- Form field names (default assumed): `username`, `password`
- Session cookie name(s): `__RECORD_FROM_STEP_2__`
- Unauthenticated response that signals "log in" (default assumed): `401` or `302 -> /login`

If any default differs, update the constants/predicate in Task 4 accordingly. No commit (documentation-only; commit alongside Task 4).

---

## Task 4: Server-side login in the embed proxy

**Files:**
- Create: `backend-api/hermesDashboardSession.ts`
- Test: `backend-api/__tests__/hermesDashboardSession.test.ts`
- Modify: `backend-api/server.ts` (`proxyEmbeddedHermes`, ~line 979-1107; constants ~line 151)

> Uses the login contract confirmed in Task 3. The helper relays **whatever** `Set-Cookie` the login returns, so it does not hardcode the session-cookie name; only the login path and form field names come from Task 3 (defaults below).

- [ ] **Step 1: Write the failing test**

Create `backend-api/__tests__/hermesDashboardSession.test.ts`:

```ts
const {
  establishHermesDashboardSession,
  needsHermesLogin,
  HERMES_DASHBOARD_LOGIN_PATH,
} = require("../hermesDashboardSession");

function res(status, { setCookie = [], location } = {}) {
  const headers = {
    getSetCookie: () => setCookie,
    get: (name) => (name.toLowerCase() === "location" ? location || null : null),
  };
  return { status, headers };
}

describe("needsHermesLogin", () => {
  it("is true on 401 and 403", () => {
    expect(needsHermesLogin(res(401))).toBe(true);
    expect(needsHermesLogin(res(403))).toBe(true);
  });
  it("is true on a redirect to the login path", () => {
    expect(needsHermesLogin(res(302, { location: `/${HERMES_DASHBOARD_LOGIN_PATH}` }))).toBe(true);
  });
  it("is false on 200", () => {
    expect(needsHermesLogin(res(200))).toBe(false);
  });
});

describe("establishHermesDashboardSession", () => {
  it("POSTs derived credentials to the login path and returns the relayed cookie string", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return res(200, { setCookie: ["hermes_session=abc; Path=/; HttpOnly", "csrf=xyz; Path=/"] });
    };
    const cookie = await establishHermesDashboardSession(
      { host: "10.0.0.5", port: 9119 },
      "seed-123",
      { fetchImpl },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`:9119/${HERMES_DASHBOARD_LOGIN_PATH}`);
    expect(calls[0].opts.method).toBe("POST");
    expect(calls[0].opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0].opts.body).toContain("username=nora");
    expect(calls[0].opts.body).toContain("password=");
    expect(cookie).toBe("hermes_session=abc; csrf=xyz");
  });

  it("returns null when the login sets no cookie", async () => {
    const fetchImpl = async () => res(200, { setCookie: [] });
    const cookie = await establishHermesDashboardSession(
      { host: "h", port: 9119 },
      "seed",
      { fetchImpl },
    );
    expect(cookie).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-api && npx jest __tests__/hermesDashboardSession.test.ts`
Expected: FAIL — cannot find module `../hermesDashboardSession`.

- [ ] **Step 3: Write the helper module**

Create `backend-api/hermesDashboardSession.ts`:

```ts
// @ts-nocheck
const { joinHttpUrl } = require("../agent-runtime/lib/agentEndpoints");
const {
  deriveHermesDashboardBasicAuth,
} = require("../agent-runtime/lib/hermesDashboardAuth");

// Confirmed against nousresearch/hermes-agent:latest in Task 3. If Task 3 found
// a different login path / field names, update these three values.
const HERMES_DASHBOARD_LOGIN_PATH = "login";
const HERMES_LOGIN_USERNAME_FIELD = "username";
const HERMES_LOGIN_PASSWORD_FIELD = "password";

// True when an upstream dashboard response indicates the session is missing or
// expired and we should (re)establish one.
function needsHermesLogin(resp) {
  if (resp.status === 401 || resp.status === 403) return true;
  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get("location") || "";
    return location.includes(HERMES_DASHBOARD_LOGIN_PATH);
  }
  return false;
}

// Log in to the Hermes dashboard with the per-agent derived basic-auth
// credential and return the concatenated cookie string to replay upstream
// (e.g. "hermes_session=...; csrf=..."), or null if login set no cookie.
async function establishHermesDashboardSession(target, seed, { fetchImpl = fetch } = {}) {
  const creds = deriveHermesDashboardBasicAuth(seed);
  const loginUrl = joinHttpUrl(target.host, target.port, HERMES_DASHBOARD_LOGIN_PATH);
  const body = new URLSearchParams({
    [HERMES_LOGIN_USERNAME_FIELD]: creds.username,
    [HERMES_LOGIN_PASSWORD_FIELD]: creds.password,
  }).toString();
  const resp = await fetchImpl(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "*/*" },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  const setCookies = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
  const pairs = setCookies.map((c) => c.split(";")[0].trim()).filter(Boolean);
  return pairs.length ? pairs.join("; ") : null;
}

module.exports = {
  HERMES_DASHBOARD_LOGIN_PATH,
  needsHermesLogin,
  establishHermesDashboardSession,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-api && npx jest __tests__/hermesDashboardSession.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the helper into `proxyEmbeddedHermes`**

In `backend-api/server.ts`, add to the requires from `./gatewayProxy`/crypto region (near line 51-58) — the module is local, so add at top-level requires:

```js
const {
  establishHermesDashboardSession,
  needsHermesLogin,
} = require("./hermesDashboardSession");
const { decrypt: decryptSecret } = require("./crypto");
```

Then in `proxyEmbeddedHermes`, replace the header-building + single fetch block (currently lines ~999-1033, from `const headers = {` through the first `let resp = await fetchUpstream();`) with:

```js
    const headers = {
      Accept: req.headers.accept || "*/*",
      "Accept-Encoding": "identity",
    };
    // Relay the stored Hermes dashboard session (established via server-side
    // login) as the upstream Cookie. The platform JWT is still never forwarded.
    let dashboardSession = cookies[dashboardTokenCookieName];
    if (dashboardSession) headers.Cookie = dashboardSession;

    const method = req.method.toUpperCase();
    let body;
    if (method !== "GET" && method !== "HEAD" && req.body != null) {
      if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
        body = req.body;
      } else if (Object.keys(req.body).length > 0) {
        body = JSON.stringify(req.body);
      }
      if (req.headers["content-type"]) {
        headers["Content-Type"] = req.headers["content-type"];
      }
    }

    const fetchUpstream = () =>
      fetch(targetUrl, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });

    let resp = await fetchUpstream();

    // If the dashboard says we're unauthenticated, log in once with the derived
    // credential, persist the session in the Nora-managed HttpOnly cookie, and
    // retry the original request with the new session.
    if (needsHermesLogin(resp)) {
      const seed = decryptSecret(access.agent.gateway_token);
      if (seed) {
        const session = await establishHermesDashboardSession(safeTarget, seed);
        if (session) {
          dashboardSession = session;
          headers.Cookie = session;
          res.cookie(dashboardTokenCookieName, session, {
            httpOnly: true,
            sameSite: "lax",
            secure: cookieSecureFlag(req),
            maxAge: EMBED_SESSION_TTL_MS,
            path: "/",
          });
          resp = await fetchUpstream();
        }
      }
    }
```

> Note: this repurposes the existing `dashboardTokenCookieName` cookie to hold the relayed Hermes session string. Leave the existing `extractHermesDashboardSessionToken` HTML handling in place (harmless); the `X-Hermes-Session-Token` header line is superseded by the `Cookie` relay and can be removed from the header block (done above by not re-adding it).

- [ ] **Step 6: Run the full provisioning + new proxy tests**

Run: `cd backend-api && npx jest __tests__/hermesDashboardSession.test.ts __tests__/provisioning.test.ts __tests__/hermesUi.test.ts __tests__/remoteHermes.test.ts`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add backend-api/hermesDashboardSession.ts backend-api/__tests__/hermesDashboardSession.test.ts backend-api/server.ts
git commit -m "feat: server-side login for embedded Hermes dashboard proxy"
```

---

## Task 5: Mirror to the Kubernetes backend

**Files:**
- Modify: `workers/provisioner/backends/k8s.ts` (`buildHermesStartCommand` ~line 313-328; hermes env map ~line 1942-1954)

- [ ] **Step 1: Add the derive-helper import**

Near the other `agent-runtime/lib` requires in `k8s.ts`, add:

```js
const {
  deriveHermesDashboardBasicAuth,
} = require("../../../agent-runtime/lib/hermesDashboardAuth");
```

- [ ] **Step 2: Drop `--insecure` from the dashboard launch**

In `k8s.ts` `buildHermesStartCommand()` (~line 320) change the dashboard line to:

```js
    `nohup "$HERMES_BIN" dashboard --host 0.0.0.0 --no-open >> ${HERMES_DASHBOARD_LOG} 2>&1 &`,
```

- [ ] **Step 3: Inject the basic-auth env into the pod env map**

In the Hermes create path, right after `const apiServerKey = config.gatewayToken || crypto.randomBytes(32).toString("hex");` (~line 1916) add:

```js
    const dashboardAuth = deriveHermesDashboardBasicAuth(apiServerKey);
```

Then in the `hermesEnvMap` literal, after `API_SERVER_KEY: apiServerKey,` (~line 1950) add:

```js
      HERMES_DASHBOARD_BASIC_AUTH_USERNAME: dashboardAuth.username,
      HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: dashboardAuth.password,
      HERMES_DASHBOARD_BASIC_AUTH_SECRET: dashboardAuth.secret,
```

- [ ] **Step 4: Regression-run the backend test suites that load k8s**

Run: `cd backend-api && npx jest __tests__/provisioning.test.ts __tests__/containerManager.test.ts`
Expected: all PASS (no assertions reference the old `--insecure` k8s command; module still loads/compiles).

- [ ] **Step 5: Commit**

```bash
git add workers/provisioner/backends/k8s.ts
git commit -m "feat: authenticated Hermes dashboard on Kubernetes backend"
```

---

## Task 6: Mirror to the Proxmox backend

**Files:**
- Modify: `workers/provisioner/backends/proxmox.ts` (env map ~line 1918-1926; launch ~line 1963; `dashboardHost`/gate ~line 1950-1951)

- [ ] **Step 1: Add the derive-helper import**

Near the other `agent-runtime/lib` requires in `proxmox.ts`, add:

```js
const {
  deriveHermesDashboardBasicAuth,
} = require("../../../agent-runtime/lib/hermesDashboardAuth");
```

- [ ] **Step 2: Derive + inject the basic-auth env**

After the line that generates `apiServerKey` in the Proxmox Hermes create path (~before line 1918), add:

```js
    const dashboardAuth = deriveHermesDashboardBasicAuth(apiServerKey);
```

Then in the env map literal, after `API_SERVER_KEY: apiServerKey,` add:

```js
      HERMES_DASHBOARD_BASIC_AUTH_USERNAME: dashboardAuth.username,
      HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: dashboardAuth.password,
      HERMES_DASHBOARD_BASIC_AUTH_SECRET: dashboardAuth.secret,
```

- [ ] **Step 3: Drop `--insecure` from the dashboard launch**

Change the launch line (~1963) to:

```js
      `nohup "$HERMES_BIN" dashboard --host ${dashboardHost} --no-open >> /var/log/nora/hermes-dashboard.log 2>&1 &`,
```

Leave the `dashboardHost`/`PROXMOX_HERMES_ENABLE_INSECURE_DASHBOARD` bind logic as-is for this change (binding is now always behind auth); the docs update in Task 8 notes the gate is now about bind address only.

- [ ] **Step 4: Regression-run the proxmox suite**

Run: `cd backend-api && npx jest __tests__/proxmoxBackend.test.ts`
Expected: PASS (module loads; existing env-file assertions unaffected).

- [ ] **Step 5: Commit**

```bash
git add workers/provisioner/backends/proxmox.ts
git commit -m "feat: authenticated Hermes dashboard on Proxmox backend"
```

---

## Task 7: Drop `--insecure` from the on-demand dashboard restart

**Files:**
- Modify: `backend-api/routes/agents.ts` (`buildHermesDashboardEnsureCommand`, ~line 923-937)

- [ ] **Step 1: Update the restart command**

In `buildHermesDashboardEnsureCommand()` (line ~931), remove `--insecure` from **both** the `gosu` and non-`gosu` branches so the restarted dashboard uses the same auth-on launch as create. The container env already carries the basic-auth vars (Tasks 2/5/6), so no credential work is needed here. Result (both branches):

```js
    'if [ "$(id -u)" = "0" ] && command -v gosu >/dev/null 2>&1; then setsid gosu hermes "$HERMES_BIN" dashboard --host 0.0.0.0 --no-open < /dev/null & else setsid "$HERMES_BIN" dashboard --host 0.0.0.0 --no-open < /dev/null & fi',
```

- [ ] **Step 2: Verify no test asserts `--insecure` on this path**

Run: `cd backend-api && grep -n "insecure" __tests__/agents.test.ts || echo "no insecure assertions"`
Expected: `no insecure assertions` (or none referencing this command).

- [ ] **Step 3: Run the agents route suite**

Run: `cd backend-api && npx jest __tests__/agents.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend-api/routes/agents.ts
git commit -m "feat: drop --insecure from Hermes dashboard restart path"
```

---

## Task 8: Update docs

**Files:**
- Modify: `docs/configuration/environment-variables.mdx` (line ~352)
- Modify: `docs/configuration/provisioner-backends/proxmox.mdx` (line ~152)

- [ ] **Step 1: Update the wording**

Replace descriptions of the "unauthenticated Hermes dashboard" with the new model: the dashboard now runs Hermes's fail-closed `basic_auth` provider with a per-agent credential Nora injects, and is reached only through Nora's authenticated embed proxy. For `PROXMOX_HERMES_ENABLE_INSECURE_DASHBOARD`, clarify it now controls only the **bind address** (loopback vs `0.0.0.0`), not authentication.

- [ ] **Step 2: Commit**

```bash
git add docs/configuration/environment-variables.mdx docs/configuration/provisioner-backends/proxmox.mdx
git commit -m "docs: describe authenticated Hermes dashboard"
```

---

## Task 9: End-to-end manual verification (Docker)

Uses the `verify`/`run` project skill if available. **Requires Docker running.**

- [ ] **Step 1: Bring up the stack and create a Hermes agent**

```bash
docker compose up -d --build backend-api worker-provisioner
```
Then create a Hermes agent via the dashboard (`/app`) or API.

- [ ] **Step 2: Confirm the dashboard starts authenticated (not fail-closed)**

```bash
docker logs <hermes-container> 2>&1 | grep -iE "dashboard|auth|refus|listen|9119"
```
Expected: dashboard binds 9119 with basic-auth engaged; no "refuses to bind" / "can only run as pid 1".

- [ ] **Step 3: Open the Web UI**

In `/app`, open the agent's Hermes WebUI → Official Dashboard tab. Expected: the dashboard loads **without** showing a login form (the proxy logged in server-side).

- [ ] **Step 4: Record the result**

Note pass/fail. If the login handshake failed, compare the live login contract to the Task 3 findings / Task 4 constants and adjust. If the dashboard uses a redirect/JS-heavy login that the server-side POST can't satisfy, implement the **fallback**: a Hermes bootstrap-script injection mirroring `buildEmbedBootstrapScript`/`injectEmbedBootstrapScript` (`server.ts:229-359`) that fills the `/login` form client-side. Re-verify.

---

## Notes / follow-ups (out of scope here)

- **WebSocket terminal/chat** (`/api/ws`, `/api/pty`) are gated by the dashboard session; Nora has no Hermes WS relay today. Track as a separate follow-up.
- **scrypt password hash**: v1 uses plaintext `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD`. Hardening to `..._PASSWORD_HASH` (Hermes scrypt format) is a follow-up.
