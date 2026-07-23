# Hermes Desktop external connect — design

**Date:** 2026-07-23
**Status:** Approved (pending spec review)
**Scope:** Local Docker deploy target only

## Problem

An operator running a Hermes agent on Nora's local Docker stack cannot connect
Hermes Desktop to it. Nora displays the agent's Runtime API as
`172.18.0.11:8642` — a Docker **compose-network internal IP**, reachable only
from inside the Docker network (`backend-api`, `worker-provisioner`).
Connecting an external client (e.g. Hermes Desktop over Tailscale to
`100.71.115.105:8642`) yields `connection refused`, because the local Docker
Hermes backend publishes **no host ports**:

```js
// workers/provisioner/backends/hermes.ts
_hermesPortBindings() {
  return undefined; // local Hermes publishes nothing
}
```

By contrast, the OpenClaw (`docker.ts`) and NemoClaw (`nemoclaw.ts`) local
Docker backends already publish host ports for their gateway/runtime. Hermes is
the only runtime family that does not — so external desktop connectivity is
inconsistent across the agents an operator adds to Nora.

## Goal

Bring local-Docker Hermes into **parity** with OpenClaw/NemoClaw: publish the
Hermes runtime API (8642) and dashboard (9119) to the host, honoring the same
`DOCKER_AGENT_BIND_IP` interface knob, and surface an externally-reachable
"connect" address + API key in the operator UI. After this change, every
runtime family added to Nora on local Docker can be reached by its external
desktop client using one consistent, documented mechanism.

Non-goals (explicitly out of scope):
- Kubernetes and Proxmox deploy targets (different exposure models — NodePort /
  LXC networking; each would be its own spec).
- Changing the remote-docker / remote-hermes backends (already publish).
- Auto-detecting a Tailscale interface (rejected: implicit-exposure default).

## Approved decisions

| Decision | Choice |
|---|---|
| Deploy-target scope | Local Docker only |
| Bind interface | Reuse `DOCKER_AGENT_BIND_IP` (default `127.0.0.1`) |
| Hermes ports published | Runtime API 8642 **and** dashboard 9119 |
| API key in UI | Show it, copyable, behind owner-scoped auth |
| Bind default | Keep `127.0.0.1`; operator sets Tailscale IP to expose |

## Key architectural constraint

Local Docker has **two consumers with different reachability needs**:

1. **Nora's own backend** (readiness probe, chat proxy, dashboard embed proxy)
   reaches the agent over the **compose network** at
   `<compose-ip>:<container-port>` (e.g. `172.18.0.11:8642`,
   `172.18.0.11:9119`). This works today and must keep working.
2. **External desktop clients** (Hermes Desktop) need
   `<bind-ip>:<published-host-port>`.

These are different `(host, port)` pairs. The design therefore **keeps the
internal address (`runtime_host`/`runtime_port` = compose IP) unchanged** and
surfaces the external address as a **separate** value. Approach B (overwriting
`runtime_host`/`runtime_port` with the published host address, as remote-hermes
does) is rejected because `backend-api` cannot reliably reach the host's
published port from inside the compose network, which would break internal
probes and proxies.

## Changes

### 1. Worker port allocation — `workers/provisioner/worker.ts`

Around the allocation block at ~line 3789–3839:

- **Allocate a dashboard host port for local-docker Hermes.** Today
  `allocatedDashboardPort` is allocated only for `deploy_target ===
  "remote-docker"` + `runtime_family === "hermes"`. Extend the condition to
  also cover `deploy_target === "docker"` + hermes.
- **Fold local-docker Hermes into `usesLocalDockerPublishedPort`.** Today this
  flag is `deploy_target === "docker" && runtime_family === "openclaw"`. Change
  it so local-docker Hermes also gets the collision-retry
  (`createWithDockerPortRetry`) and occupied-port detection
  (`getOccupiedDockerPublishedPorts`) that OpenClaw already enjoys.
- **Extend occupied/collision handling to the dashboard slot.** Hermes now
  publishes two host ports (runtime via `gatewayHostPort`, dashboard via
  `dashboardHostPort`). The gateway/runtime slot is covered by the existing
  retry helper. For the dashboard slot, reuse the same allocator
  (`allocateGatewayPort` with `DASHBOARD_PORT_PURPOSE`, DB-backed and
  collision-safe) plus an `isHostPortBound` pre-check, mirroring how remote
  Hermes allocates its dashboard port. Add the dashboard port to the occupied
  set so the gateway retry never collides with it.

### 2. Hermes backend — `workers/provisioner/backends/hermes.ts`

- **Rewrite `_hermesPortBindings(config)`** to publish both ports, each bound to
  `this._publishedPortHostIp(config)` (inherited from `DockerBackend`, honoring
  `DOCKER_AGENT_BIND_IP`):
  - `8642/tcp` → `config.gatewayHostPort` (runtime API)
  - `9119/tcp` → `config.dashboardHostPort` (dashboard)
  - Omit a binding whose port is missing/invalid; return `undefined` only when
    neither is allocated (safety fallback preserving current behavior).
- **`create()` return value:** after `container.start()`, inspect the published
  bindings and return `gatewayHostPort` (published 8642 host port) and
  `dashboardPort` (published 9119 host port). **Keep `host` / `runtimeHost` =
  compose IP and `runtimePort` = 8642 unchanged.**
- `remote-hermes.ts` is **untouched** — it overrides both `_hermesPortBindings`
  (hardcoded `0.0.0.0`) and `create()`. Verify its tests still pass.

### 3. Persistence & the resolver trap

- `gateway_host_port` and `dashboard_port` columns already exist — **no schema
  change**. `gateway_host_port` stores the published runtime-API host port. It
  is display-only for Hermes: `resolveGatewayAddress` returns `null` for hermes
  (`runtimeExposesGateway` is false), so no internal path misreads it.
- **Trap being designed around:** `resolveHermesDashboardAddress`
  (`agent-runtime/lib/agentEndpoints.ts`) combines `runtime_host` (compose IP
  for local) with `dashboard_port`. If we wrote the published *host* dashboard
  port into `dashboard_port`, the embed proxy would target
  `<compose-ip>:<host-port>` — which is wrong, because the compose IP only
  exposes the container port 9119. **Therefore, for local Docker we do NOT feed
  the published dashboard host port into `dashboard_port`.** The embed path
  keeps falling back to `<compose-ip>:9119` exactly as today. The published
  dashboard host port is carried separately (see §4) and surfaced only through
  the connect endpoint.
  - Implementation note: this differs from remote-docker, where `runtime_host`
    is the advertised host address, so `runtime_host:dashboard_port` is
    correct. The local vs. remote distinction is by `deploy_target`.
  - The published runtime-API and dashboard host ports for local Docker are
    persisted for display via a channel that does **not** collide with the
    embed resolver — carried on `gateway_host_port` (runtime API, safe as shown
    above) and surfaced for the dashboard via on-demand inspection in the
    connect endpoint (§4). No new column required.

### 4. Connect surface

**Backend** — extend the existing Hermes runtime-info response at
`backend-api/routes/agents.ts:1351` (the `GET /:id/hermes-ui` handler) with a
`connect` block, computed with the same helpers OpenClaw's `ui-info` uses:

```js
connect: {
  runtimeApiUrl: `${proto}://${resolvePublishedGatewayHost(req)}:${runtimeApiHostPort}`,
  dashboardUrl:  `${proto}://${resolvePublishedGatewayHost(req)}:${dashboardHostPort}`,
  apiKey: agent.gateway_token, // API_SERVER_KEY
  bindHost: <DOCKER_AGENT_BIND_IP or resolved host>,
}
```

- `resolvePublishedGatewayHost(req)` resolves to the host the operator browsed
  Nora on (X-Forwarded-Host / Host header) — i.e. the Tailscale IP when the
  operator reaches Nora over Tailscale — or `GATEWAY_HOST` when configured.
- `resolvePublishedGatewayProtocol(req)` → plain `http` for direct agent ports.
- `runtimeApiHostPort` comes from the persisted `gateway_host_port`.
  `dashboardHostPort` is **inspected on demand** from the running container's
  published `9119/tcp` binding (the same `docker inspect` fallback the OpenClaw
  `ui-info` handler already uses for a missing `gateway_host_port`) — it is
  deliberately **not** persisted into `dashboard_port`, per the resolver trap in
  §3.
- Only include `connect` when the agent is running on local Docker and the
  published ports exist. Owner-scoped auth already gates this route.

**Frontend** — `frontend-dashboard/components/agents/hermes/StatusPanel.tsx`
gains a "Connect Hermes Desktop" card next to the existing "Runtime API" card,
rendering `runtimeInfo.connect`: runtime API URL, dashboard URL, and the API
key, each with a copy button. Shown only when `runtimeInfo.connect` is present.
Existing "Runtime API" card (internal compose address) stays as-is for
operator diagnostics.

### 5. Config & docs

- `.env.example`: update the `DOCKER_AGENT_BIND_IP` comment to state it now
  governs Hermes too, and to set it to a routable/Tailscale IP (e.g.
  `100.71.115.105`) to allow external desktop clients. Keep the loopback default
  and the 0.0.0.0 firewall warning.
- Update the local-Hermes "publishes nothing" notes in
  `workers/provisioner/backends/hermes.ts` comments and any README/CLAUDE.md
  architecture text that states local Hermes is reachable only via the compose
  network.

### 6. Tests

- **Worker allocation** (`backend-api/__tests__/provisioning.test.ts` or the
  worker's test): local-docker Hermes allocates both a gateway/runtime host port
  and a dashboard host port, and participates in the published-port
  collision-retry path.
- **Hermes backend** (`workers/provisioner/backends` tests): `_hermesPortBindings`
  publishes `8642` and `9119` bound to the configured `DOCKER_AGENT_BIND_IP`;
  `create()` returns `gatewayHostPort` + `dashboardPort`; `runtimeHost` stays the
  compose IP and `runtimePort` stays `8642`.
- **agentEndpoints** (`backend-api/__tests__/agentEndpoints.test.ts`):
  `resolveHermesDashboardAddress` for a local-docker agent still returns
  `<compose-ip>:9119` (embed proxy unchanged).
- **Connect endpoint** (`backend-api/__tests__/hermesUi.test.ts`): the
  `hermes-ui` response includes a `connect` block with the externally-reachable
  URLs (derived from X-Forwarded-Host) and the API key for a running local-docker
  Hermes agent; absent when ports are unpublished.
- **remote-hermes** (`backend-api/__tests__/remoteHermes.test.ts`): unchanged —
  regression guard.

## Verification

1. `cd backend-api && npm test` — allocation, endpoints, agentEndpoints,
   remoteHermes suites pass.
2. Manual/e2e: deploy a local-docker Hermes agent with
   `DOCKER_AGENT_BIND_IP=<tailscale-ip>`; confirm `docker inspect` shows
   `8642/tcp` and `9119/tcp` published on that IP; confirm the StatusPanel
   "Connect Hermes Desktop" card shows a reachable URL + key; connect Hermes
   Desktop over Tailscale successfully.
3. Regression: the in-Nora Hermes chat, dashboard embed, and readiness all still
   work (internal compose path unchanged).

## Blast radius

`workers/provisioner/backends/hermes.ts` and `worker.ts` are shared/mounted
zones (backend-api + worker). `agent-runtime/lib/agentEndpoints.ts` is shared
read-only into both services. This design intentionally leaves the shared
resolver behavior (`resolveHermesDashboardAddress`) unchanged for local Docker
and adds only additive surfaces, keeping the blast radius contained.
