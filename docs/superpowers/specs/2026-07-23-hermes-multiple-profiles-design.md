# Hermes Multiple Profiles — Design

**Date:** 2026-07-23
**Status:** Approved (design)
**Scope owner areas:** `workers/provisioner/backends/` (Hermes adapters — shared blast radius),
`agent-runtime/lib/` (shared contracts), `backend-api/` (routes + `hermesUi.ts`),
`frontend-dashboard/` (operator UI).

## Problem

The Hermes agent runtime natively supports **profiles** — multiple fully isolated agent
identities on a single runtime, each with its own `HERMES_HOME` directory (`config.yaml`,
`.env`, `SOUL.md`, channels, cron, sessions, memory, skills, and its own gateway). See the
Hermes docs: profiles live at `HERMES_HOME/profiles/<name>` (the default profile is
`HERMES_HOME` itself), are managed with `hermes profile create|list|show|rename|delete|use`,
and are targeted per-command with `hermes -p <name> <cmd>` or by setting `HERMES_HOME`.

Nora does not model this. It assumes **one profile per runtime**:

- The container hardcodes `HERMES_HOME=/opt/data` and starts a single `hermes gateway run`
  plus a single `hermes dashboard`
  (`workers/provisioner/backends/hermes.ts`, `agent-runtime/lib/hermesRuntimeBootstrap.ts`).
- `hermes_runtime_state` stores exactly one `model_config` + `channel_configs` row per
  **agent** (`backend-api/hermesUi.ts`).
- Every `hermesUi.ts` Python helper runs against the default config, because
  `hermes_cli.config` resolves paths from the container's single `HERMES_HOME`.

We want operators to **create, detect, and switch between Hermes profiles on a single agent
runtime**, from the Nora agent dashboard, with per-profile configuration.

## Goals

- Model Hermes profiles as a **sub-resource of a single Nora Hermes agent** (agent = one
  runtime/container hosting many profiles).
- **Detect** profiles (including ones created out-of-band) and their gateway running state.
- **Create** (optionally cloning) and **delete** profiles from the Nora dashboard.
- Run **all profile gateways concurrently** inside the runtime, so every profile is live on
  its channels at once.
- Give the Nora dashboard a **profile selector** that scopes the Channels / Cron / Status /
  Chat / Model-config views to the selected profile.
- Store per-profile configuration in Nora (model + channels), keyed by `(agent, profile)`.

## Non-goals (v1)

- Kubernetes and Proxmox Hermes multi-profile support (Docker + remote-hermes only this
  iteration).
- Per-profile **official** Hermes dashboards. A single official dashboard runs on the default
  profile; it has its own native profile switcher for WebUI users.
- Per-profile published/host API ports.
- Editing `SOUL.md` / skills per profile from Nora (use the official WebUI for those).

## Key decisions

1. **Profiles are nested under one agent.** No new top-level agent records; a Hermes agent
   gains a profile dimension.
2. **All gateways run concurrently.** The default profile's gateway remains the container's
   primary (`exec`'d) process; each named profile runs an additional **background**
   `hermes gateway run`.
3. **Non-default gateways need no API server and no extra ports.** Nora reads every profile's
   config/status via `docker exec` with `HERMES_HOME` set (not the runtime API) and detects
   running profiles via `hermes profile list`. Named-profile gateways run with
   `API_SERVER_ENABLED=false`, so there is **no port allocation, no host publishing, and no
   per-profile proxy routing**. This is the central simplification of the design.
4. **One official dashboard**, default profile, unchanged. Native switcher covers WebUI.
5. **Deploy targets:** local Docker + remote-hermes (remote inherits the same `docker exec`
   path). Kubernetes is guarded off for profile management in v1.

## Architecture

```
Nora agent (runtime_family = hermes)  ── one container ──┐
  HERMES_HOME=/opt/data            → default profile     │  gateway (PID 1, exec) + dashboard (bg)
  /opt/data/profiles/<name-A>      → profile A           │  gateway (bg, API_SERVER_ENABLED=false)
  /opt/data/profiles/<name-B>      → profile B           │  gateway (bg, API_SERVER_ENABLED=false)
                                                          ┘
Nora dashboard  →  profile selector  →  scopes Channels/Cron/Status/Chat/Model to a profile
Official Hermes dashboard (default profile, port 9119)  →  native profile switch (unchanged)
```

### Profile home resolution

- `default` → `/opt/data` (unchanged; the current single-profile behavior).
- `<name>` → `/opt/data/profiles/<name>`.

A shared helper (in `agent-runtime/lib/hermesRuntimeBootstrap.ts`) resolves a profile name to
its `HERMES_HOME` so the container start command and the backend Python helpers agree on the
path. Profile names are validated (`^[a-z0-9][a-z0-9-]{0,62}$`, `default` reserved for the
default profile) before ever reaching a shell/exec.

## Data model

New table:

```sql
CREATE TABLE hermes_profiles (
  agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,             -- 'default' | validated slug
  display_name  TEXT,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, name)
);
```

`hermes_runtime_state` becomes per-(agent, profile):

- Add `profile_name TEXT NOT NULL DEFAULT 'default'`.
- Replace the `agent_id` uniqueness with `UNIQUE (agent_id, profile_name)`.
- `model_config` + `channel_configs` are now stored per profile.

Migration (`backend-api/agentMigrations.ts` style):

1. Add `profile_name` to `hermes_runtime_state` with default `'default'`; existing rows adopt
   `'default'`; swap the unique constraint.
2. Create `hermes_profiles`; backfill one `default` row (`is_default = TRUE`) for every agent
   with `runtime_family = 'hermes'`.

## Runtime / container changes

`agent-runtime/lib/hermesRuntimeBootstrap.ts` + `workers/provisioner/backends/hermes.ts`:

- `buildHermesStartCommand()` keeps starting the default gateway (as PID 1 via `exec`) and the
  single dashboard. It gains a step that, **after** the default bootstrap, enumerates
  `/opt/data/profiles/*` and launches each profile's gateway in the background:

  ```sh
  for prof_dir in "$HERMES_HOME"/profiles/*/; do
    [ -d "$prof_dir" ] || continue
    nohup env HERMES_HOME="$prof_dir" API_SERVER_ENABLED=false \
      "$HERMES_BIN" gateway run >> "$prof_dir/gateway.log" 2>&1 &
  done
  ```

- Profiles persist on the mounted Hermes home volume, so "all gateways running" survives
  container restart / redeploy — the start command re-launches them every boot.
- We deliberately do **not** use `hermes gateway start` (managed systemd/launchd service): the
  container has no user systemd. Backgrounding `gateway run` mirrors how the dashboard is
  already backgrounded today.

## Backend

### `backend-api/hermesUi.ts`

- **Profile threading.** Add a `profile = 'default'` argument to `buildHermesPythonCommand` /
  `runHermesPython` / `runHermesPythonJson`; it prefixes `export HERMES_HOME=<profile home>`
  so `hermes_cli.config` scopes to that profile. Thread `profile` through
  `getPersistedHermesState`, `replacePersistedHermesState`, `persistHermesChannelState`,
  `deletePersistedHermesChannelState`, `persistHermesChannelConfig`,
  `persistHermesModelConfig`, `readHermesRuntimeSnapshot`, `listHermesChannels`,
  `saveHermesChannel`, `deleteHermesChannel`, `testHermesChannel`, `applyPersistedHermesState`.
  DB reads/writes filter on `(agent_id, profile_name)`.

- **New profile helpers:**
  - `listHermesProfiles(agent)` — run `hermes profile list` (machine-readable if available,
    else parse), reconcile with the `hermes_profiles` registry (auto-register out-of-band
    profiles; ensure a `default` always exists), and report each profile's gateway running
    state.
  - `createHermesProfile(agent, name, { cloneFrom } = {})` — validate name → `hermes profile
    create <name>` (with `--clone-from` when given) → insert `hermes_profiles` row → launch the
    profile's background gateway.
  - `deleteHermesProfile(agent, name)` — refuse `default`; stop the gateway; `hermes profile
    delete`; remove the `hermes_profiles` + `hermes_runtime_state` rows.
  - `startProfileGateway` / `stopProfileGateway` / `restartProfileGateway(agent, name)` — exec
    background `gateway run` / targeted `pkill` of the profile's gateway process.

- **Restart semantics.** A config change on a **named** profile restarts only that profile's
  background gateway (kill + relaunch) — smaller blast radius than today. A change on the
  **default** profile keeps today's behavior (`restartHermesRuntime` → container restart),
  because the default gateway is PID 1.

### `backend-api/routes/agents.ts`

- `GET  /:id/hermes-ui/profiles` — list profiles + running state + which is default.
- `POST /:id/hermes-ui/profiles` — `{ name, cloneFrom? }` create.
- `DELETE /:id/hermes-ui/profiles/:name` — delete (rejects `default`).
- `POST /:id/hermes-ui/profiles/:name/gateway` — `{ action: 'start' | 'stop' | 'restart' }`.
- Existing `hermes-ui` channel / cron / model / status routes accept `?profile=<name>`
  (default `'default'`); handlers validate the profile belongs to the agent before use.

### Deploy-target guard

Remote-hermes inherits the Docker `runContainerCommand` exec path, so it works unchanged.
Kubernetes Hermes agents (`isKubernetesHermesAgent`) return a clear "not supported in this
version" error from the profile routes, and the frontend hides profile management for them.

## Frontend (`frontend-dashboard`)

- **`components/agents/HermesWebUITab.tsx`**: add a profile selector dropdown beside the
  sub-tab bar, with "New profile" (create, optional clone-from), delete, and start/stop
  controls, plus a running/stopped badge per profile from `GET …/profiles`. Hold
  `selectedProfile` state (default `'default'`).
- Pass `selectedProfile` into the **Status**, **Chat**, **Cron**, and **Channels** panels and
  the **model config**, each of which appends `?profile=<name>` to its fetches.
- The **Official Dashboard** sub-tab is unchanged and shows a short hint that it reflects the
  default profile and uses Hermes's native profile switcher.
- Profile controls are hidden for Kubernetes Hermes agents (v1 guard).

## Testing

- **Backend (Jest, `backend-api/__tests__`)**:
  - `HERMES_HOME` scoping in the Python command builder (default vs named).
  - Per-(agent, profile) persistence in `hermes_runtime_state`; the migration.
  - Profile CRUD + reconciliation-merge (out-of-band profile appears; `default` always
    present; name validation rejects bad slugs and `default` on create).
  - Route `profile` validation (unknown profile → 400/404; k8s → not-supported).
- **E2E smoke (`e2e`)**: create a profile, configure a channel on it, assert the config is
  scoped to that profile and does not leak into `default`, then switch the selector and see the
  other profile's config.

## Rollout / compatibility

- The migration is backward compatible: every existing Hermes agent gains a `default` profile
  and its current `hermes_runtime_state` becomes the `default` row — no behavior change for
  agents that never create a second profile.
- The container start command's profile loop is a no-op when `/opt/data/profiles` is empty, so
  existing single-profile containers behave exactly as before.

## Open risks / notes

- **`hermes profile list` output format.** If a machine-readable (`--json`) form is not
  available in the pinned image, `listHermesProfiles` parses the human table; the parser must
  tolerate format drift and always fall back to the DB registry + on-disk `profiles/*`
  enumeration.
- **Default-profile restart cost.** Editing the default profile still triggers a full
  container restart (unchanged). Named-profile edits avoid it. Documented, accepted for v1.
- **Shared blast radius.** `workers/provisioner/backends/` and `agent-runtime/lib/` changes hit
  both backend-api and the worker; verify both consumers after the runtime/bootstrap edits.
