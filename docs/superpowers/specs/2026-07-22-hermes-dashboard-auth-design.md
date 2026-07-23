# Hermes Dashboard Authentication (basic-auth provider)

**Date:** 2026-07-22
**Status:** Approved design — pending implementation plan
**Related:** #297 (baked-in `API_SERVER_KEY`); this reuses that baked-env pattern

## Problem

As of the June 2026 Hermes hardening, the dashboard is **fail-closed**: a
non-loopback bind (`--host 0.0.0.0`, which every Nora backend uses) with no
auth provider configured refuses to start, and `--insecure` /
`HERMES_DASHBOARD_INSECURE=1` no longer yields a working unauthenticated
dashboard. Nora launches the dashboard with `--insecure` in four places, so
after pulling the latest `nousresearch/hermes-agent:latest` image the Web UI
no longer opens for newly created agents.

The new dashboard supports three auth providers via `HERMES_DASHBOARD_*` env
vars (env overrides `config.yaml`): username/password (basic auth, session
based, `/login` HTML form), Nous OAuth (interactive per-instance registration),
and self-hosted OIDC. Dashboard auth is entirely separate from the gateway
`API_SERVER_KEY` (port 8642).

Sources:
- https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard
- https://hermes-agent.nousresearch.com/docs/reference/cli-commands

## Decision

Adopt the **basic-auth provider** with a **per-agent generated credential**.
Nora's existing embed proxy (`proxyEmbeddedHermes`) logs in server-side on the
operator's behalf and relays the resulting session. The dashboard port (9119)
remains unreachable except through Nora's already-authenticated proxy, so this
satisfies Hermes fail-closed without changing Nora's trust boundary.

Rejected alternatives:
- **Loopback + no auth** — fail-closed forbids unauthenticated non-loopback
  binds, and a `127.0.0.1` bind is unreachable from the separate backend-api
  proxy container. Non-viable.
- **OAuth / OIDC** — Nous OAuth needs interactive per-agent registration; OIDC
  needs Nora to run an IdP and pipe browser redirects through the same-origin
  embed proxy. Real external dependency and much heavier. Reserve for a future
  "expose dashboards publicly" story.
- **Adding an encrypted `dashboard_auth` DB column** — rejected in favor of
  deriving the credential from the existing per-agent secret (below), which
  avoids a migration and avoids touching the many agent INSERT/UPDATE sites.

## Architecture

### 1. Credential model — derived, no DB migration

New shared helper in the read-only runtime contract mounted into **both** the
worker and backend-api:

`agent-runtime/lib/hermesDashboardAuth.ts`

```
deriveHermesDashboardBasicAuth(seed) -> { username, password, secret }
```

- `username` — fixed (`"nora"`).
- `password` — `HMAC-SHA256(seed, "hermes-dashboard-password")`, hex.
- `secret`   — `HMAC-SHA256(seed, "hermes-dashboard-secret")`, hex (the 32-byte
  token-signing key Hermes requires).
- `seed`     — the agent's `API_SERVER_KEY` (a.k.a. `gatewayToken`).

Both sides already hold the seed: the worker generates `apiServerKey` at create
time; the backend-api proxy decrypts it via `gatewayTokenForAgent(agent)`
(`gatewayProxy.ts:434`). No new persisted secret, no migration, no new
persistence plumbing. The credential is stable for the life of the container
and re-derives identically on supervised restarts.

Trade-off: the dashboard credential is cryptographically bound to the gateway
key. Both are per-agent secrets injected into the same container and encrypted
at rest, so this does not widen the blast radius. If the gateway key rotates,
the agent is recreated and the derived credential re-injects.

### 2. Container launch + env (four sites)

Bake three env vars into the container environment (same baked-in `Env`
approach as the #297 `API_SERVER_KEY` fix, so the s6-supervised dashboard reads
them from `/run/s6/container_environment` on every boot, including
auth-reconcile restarts):

- `HERMES_DASHBOARD_BASIC_AUTH_USERNAME`
- `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD`  (plaintext for v1 — see Open Questions)
- `HERMES_DASHBOARD_BASIC_AUTH_SECRET`

Change the launch command to **drop `--insecure`**, keeping
`hermes dashboard --host 0.0.0.0 --port 9119 --no-open`. With the basic-auth
env present, the dashboard starts fail-closed-safe with auth enabled.

Sites to change:
- `workers/provisioner/backends/hermes.ts` (`buildHermesStartCommand`, launch
  line; `create()` env array + derive call) — Docker, primary.
- `workers/provisioner/backends/k8s.ts` (`buildHermesStartCommand`; pod env
  map ~`k8s.ts:1950`).
- `workers/provisioner/backends/proxmox.ts` (launch ~`1963`; env injection
  ~`1922`; revisit the `PROXMOX_HERMES_ENABLE_INSECURE_DASHBOARD` gate /
  `dashboardHost` at ~`1950` — with auth always on, keep binding behavior
  minimal and note the gate is now redundant).
- `backend-api/routes/agents.ts` (`buildHermesDashboardEnsureCommand` ~`931`,
  the on-demand dashboard restart path).

### 3. Proxy authentication — `proxyEmbeddedHermes` (`backend-api/server.ts:979`)

Server-side login handshake, reusing the existing per-agent Nora-managed cookie
machinery:

1. Derive credentials from `gatewayTokenForAgent(access.agent)`.
2. Ensure a Hermes session: if the `__nora_hermes_dashboard_token_<agentId>`
   cookie is absent, or the upstream returns 401 / a redirect to the login
   page, POST the credentials to the Hermes login endpoint, capture the
   `Set-Cookie` session, and store it in that HttpOnly cookie.
3. Replay the stored session as a `Cookie` header on upstream fetches.
4. On 401/login-redirect mid-session, re-login once and retry the request.

Unchanged: the JWT → `__nora_hermes_embed_<agentId>` embed-session boundary
(`resolveEmbedAccess`), the SSRF allowlist (`resolveSafeHermesDashboardTarget`),
and the rule that the platform JWT is **never** forwarded upstream
(`server.ts:1006-1010`).

Fallback (if the login flow proves redirect/JS-heavy and a clean server-side
POST is impractical): client-side auto-login injection mirroring the proven
OpenClaw `injectEmbedBootstrapScript` / `buildEmbedBootstrapScript`
(`server.ts:229-359`), adapted to fill the Hermes `/login` form.

### 4. WebSocket terminal/chat — explicit follow-up (out of scope here)

Hermes `/api/ws` and `/api/pty` are gated by the same dashboard session. Nora
has no Hermes WebSocket relay today (the existing relay is OpenClaw-only). This
change scopes to the **HTTP dashboard loading authenticated**. The WS terminal
relay is a separate, flagged follow-up — not silently dropped.

## Scope / rollout

Docker end-to-end (derive helper + `hermes.ts` + proxy) with tests, then mirror
the identical env/launch change to `k8s.ts`, `proxmox.ts`, and the
`routes/agents.ts` restart path.

## Testing

- **Unit — derive helper:** determinism (same seed → same triple); distinct
  labels → distinct password/secret; hex shape/length.
- **Unit — provisioning (`provisioning.test.ts`, extend the #297 test):**
  container `Env` contains the three `HERMES_DASHBOARD_BASIC_AUTH_*` vars with
  values matching `deriveHermesDashboardBasicAuth(gatewayToken)`; launch command
  no longer contains `--insecure`.
- **Unit — proxy login:** mock upstream sequence 401 → login 200 (`Set-Cookie`)
  → resource 200; assert the proxy performs login, stores the Nora cookie,
  relays `Cookie` upstream, and re-logins on a later 401.
- **Manual / e2e (Docker up):** create a Hermes agent, open the Web UI, confirm
  it loads authenticated. This is also the verification gate for the endpoint
  specifics below.

## Open questions / verification gates

1. **Exact Hermes login contract** — endpoint path, form field names, and
   session-cookie name are not in the public docs. Confirm against the running
   `nousresearch/hermes-agent:latest` image (requires Docker) before finalizing
   the proxy handshake. The plan gates the proxy step on this.
2. **Plaintext vs scrypt hash** — v1 uses plaintext `..._PASSWORD` (documented,
   machine-random value, only in container env + derived on demand). Computing
   Hermes's scrypt `..._PASSWORD_HASH` format is a hardening follow-up.
3. **Proxmox insecure-dashboard gate** — `PROXMOX_HERMES_ENABLE_INSECURE_DASHBOARD`
   becomes largely redundant once auth is always on; decide keep-vs-remove
   during implementation (lean: keep binding behavior, update docs).

## Docs to update

- `docs/configuration/environment-variables.mdx:352` and
  `docs/configuration/provisioner-backends/proxmox.mdx:152` — currently describe
  the "unauthenticated Hermes dashboard"; update for the new auth model.
