# Hermes Desktop External Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator connect Hermes Desktop (and any external client) to a Hermes agent on Nora's local Docker stack by publishing the runtime API (8642) and dashboard (9119) ports to the host and surfacing a reachable connect address + API key in the UI.

**Architecture:** Bring local-Docker Hermes into parity with OpenClaw/NemoClaw. The worker allocates a second host port (dashboard) for local Hermes and routes it through the existing published-port collision path; the Hermes backend publishes both container ports to the host interface named by `DOCKER_AGENT_BIND_IP`. Nora's own proxy/probe traffic stays on the compose network (`runtime_host`/`runtime_port` unchanged); the externally-reachable address is computed on demand and returned in a new `connect` block on the `hermes-ui` runtime-info response, rendered as a "Connect Hermes Desktop" card.

**Tech Stack:** Node 24, Express, dockerode, Jest (backend), Next.js 16 + React + lucide-react (frontend).

## Global Constraints

- Scope is **local Docker only** (`deploy_target === "docker"`). Do not modify k8s, Proxmox, remote-docker, or remote-hermes behavior.
- `DOCKER_AGENT_BIND_IP` default stays `127.0.0.1`. Never bind `0.0.0.0` implicitly.
- **Do not change** `runtime_host` / `runtime_port` for local Hermes — they must stay the compose IP + `8642` so internal probes and the chat/embed proxy keep working.
- **Do not** write the published dashboard *host* port into the `dashboard_port` column for local Docker — that column feeds `resolveHermesDashboardAddress`, which combines it with the compose IP for the embed proxy.
- `workers/provisioner/backends/hermes.ts` and `workers/provisioner/worker.ts` are shared/mounted zones (backend-api + worker) — verify both consumers.
- The Hermes API key (`gateway_token`) is **encrypted at rest**; read it via `resolveHermesApiToken(agent)`, never `agent.gateway_token` directly.
- Ports: Hermes runtime API = `8642`, Hermes dashboard = `9119` (`HERMES_DASHBOARD_PORT` from `agent-runtime/lib/contracts`).
- Backend tests run from `backend-api/` with `npx jest <file>`.

---

### Task 1: Publish Hermes host ports honoring `DOCKER_AGENT_BIND_IP`

Make the base `HermesBackend` publish `8642` (from `gatewayHostPort`) and `9119` (from `dashboardHostPort`) to the host, bound to `_publishedPortHostIp(config)`. **`create()`'s return value is intentionally left unchanged** — we do NOT return/persist the published host ports (persisting the dashboard host port would corrupt `resolveHermesDashboardAddress`; the connect endpoint in Task 3 inspects the live bindings on demand instead). This also keeps remote-hermes behavior byte-for-byte unchanged.

**Files:**
- Modify: `workers/provisioner/backends/hermes.ts:168-170` (`_hermesPortBindings` only)
- Test: `backend-api/__tests__/remoteHermes.test.ts` (update the stale local-publish assertion; this file already exercises `HermesBackend.prototype._hermesPortBindings`)

**Interfaces:**
- Consumes: `config.gatewayHostPort` (number, published host port for runtime API 8642), `config.dashboardHostPort` (number, published host port for dashboard 9119), `this._publishedPortHostIp(config)` (inherited from `DockerBackend`, returns `DOCKER_AGENT_BIND_IP` or `127.0.0.1`).
- Produces: `_hermesPortBindings(config)` returns a dockerode `PortBindings` map or `undefined`. `create()`'s return shape is unchanged (`runtimeHost`=compose IP, `runtimePort`=8642). The published ports reach Docker only through the `PortBindings` in `createContainer` (already wired at `hermes.ts:252`).

- [ ] **Step 1: Update the stale unit tests in `remoteHermes.test.ts`**

Find the `describe` block covering `_hermesPortBindings` (contains `"leaves local Hermes unpublished (base hook returns undefined)"`). Replace that single `it(...)` with the new base-class behavior:

```js
  it("base HermesBackend publishes runtime + dashboard on the configured host IP", () => {
    // Local Hermes now publishes to the DOCKER_AGENT_BIND_IP interface (default
    // loopback) so external desktop clients can reach the runtime API.
    const bindings = HermesBackend.prototype._hermesPortBindings.call(
      { _publishedPortHostIp: () => "127.0.0.1" },
      { gatewayHostPort: 19500, dashboardHostPort: 19044 },
    );
    expect(bindings).toEqual({
      "8642/tcp": [{ HostIp: "127.0.0.1", HostPort: "19500" }],
      "9119/tcp": [{ HostIp: "127.0.0.1", HostPort: "19044" }],
    });
  });

  it("base HermesBackend honors a routable DOCKER_AGENT_BIND_IP", () => {
    const bindings = HermesBackend.prototype._hermesPortBindings.call(
      { _publishedPortHostIp: () => "100.71.115.105" },
      { gatewayHostPort: 19500 },
    );
    expect(bindings).toEqual({
      "8642/tcp": [{ HostIp: "100.71.115.105", HostPort: "19500" }],
    });
  });

  it("base HermesBackend publishes nothing when no host port is allocated", () => {
    expect(
      HermesBackend.prototype._hermesPortBindings.call(
        { _publishedPortHostIp: () => "127.0.0.1" },
        {},
      ),
    ).toBeUndefined();
    expect(HermesBackend.prototype._hermesPortBindings()).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend-api && npx jest __tests__/remoteHermes.test.ts -t "base HermesBackend"`
Expected: FAIL — current `_hermesPortBindings` returns `undefined` regardless of args.

- [ ] **Step 3: Rewrite `_hermesPortBindings` in `workers/provisioner/backends/hermes.ts`**

Replace the current method (lines ~165-170):

```js
  // Host port mapping for the Hermes container. Local Hermes publishes nothing
  // (reached via the container IP on the shared compose network); the remote
  // variant overrides this to publish the dashboard port on the remote host.
  _hermesPortBindings() {
    return undefined;
  }
```

with:

```js
  // Host port mapping for the Hermes container. Local Hermes publishes the
  // runtime API (8642) and dashboard (9119) on the host interface named by
  // DOCKER_AGENT_BIND_IP (default loopback) so external desktop clients can
  // connect. The remote variant overrides this to bind 0.0.0.0 on the remote
  // host. Ports the caller did not allocate are simply omitted.
  _hermesPortBindings(config = {}) {
    const hostIp = this._publishedPortHostIp(config);
    const bindings = {};
    const runtimePort = Number(config?.gatewayHostPort);
    if (Number.isInteger(runtimePort) && runtimePort >= 1 && runtimePort <= 65535) {
      bindings[`${HERMES_RUNTIME_PORT}/tcp`] = [{ HostIp: hostIp, HostPort: String(runtimePort) }];
    }
    const dashboardPort = Number(config?.dashboardHostPort);
    if (Number.isInteger(dashboardPort) && dashboardPort >= 1 && dashboardPort <= 65535) {
      bindings[`${HERMES_DASHBOARD_PORT}/tcp`] = [
        { HostIp: hostIp, HostPort: String(dashboardPort) },
      ];
    }
    return Object.keys(bindings).length ? bindings : undefined;
  }
```

Note: `HERMES_DASHBOARD_PORT` is already imported at the top of the file; `HERMES_RUNTIME_PORT` is the module constant `8642`. `_publishedPortHostIp` is inherited from `DockerBackend`. **Do not modify `create()`** — the bindings returned here are consumed by the existing `PortBindings: this._hermesPortBindings(config)` line in `createContainer` (`hermes.ts:252`), so publishing takes effect with no other change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend-api && npx jest __tests__/remoteHermes.test.ts -t "base HermesBackend"`
Expected: PASS.

- [ ] **Step 5: Run the full remote + provisioning suites (regression guard)**

Run: `cd backend-api && npx jest __tests__/remoteHermes.test.ts __tests__/provisioning.test.ts`
Expected: PASS. In particular the old "leaves local Hermes unpublished" expectation is gone, the Hermes `create()` test still sees `runtimeHost`/`runtimePort` unchanged, and remote-hermes `_hermesPortBindings`/`create` tests are untouched. If the provisioning Hermes-create test passes no `gatewayHostPort`, `PortBindings` stays `undefined` — confirm no assertion regressed.

- [ ] **Step 6: Commit**

```bash
git add workers/provisioner/backends/hermes.ts backend-api/__tests__/remoteHermes.test.ts
git commit -m "feat(hermes): publish local Docker runtime + dashboard ports to host"
```

---

### Task 2: Allocate the dashboard host port for local-Docker Hermes

Extend the worker so local-Docker Hermes allocates a dashboard host port and participates in the same published-port collision path OpenClaw uses.

**Files:**
- Modify: `workers/provisioner/worker.ts:3804-3839` (allocation block) — `usesLocalDockerPublishedPort` and the dashboard-port allocation condition
- Test: `backend-api/__tests__/provisioning.test.ts` (allocation-focused describe block)

**Interfaces:**
- Consumes: `deployTarget` (string), `resolvedRuntimeFields.runtime_family` (string), `allocateGatewayPort({ hostKey, agentId, purpose?, unavailablePorts? })`, `DASHBOARD_PORT_PURPOSE`, `getOccupiedDockerPublishedPorts(provisioner, { agentId })`, `LOCAL_HOST_KEY`.
- Produces: `allocatedGatewayPort` (runtime API 8642 host port) and `allocatedDashboardPort` (dashboard 9119 host port) are passed to `provisioner.create()` as `gatewayHostPort` / `dashboardHostPort` for local-Docker Hermes; `usesLocalDockerPublishedPort` is `true` for local-Docker Hermes so `createWithDockerPortRetry` wraps the create.

- [ ] **Step 1: Write the failing test**

Add to the allocation `describe` block in `backend-api/__tests__/provisioning.test.ts` (near the existing "docker gateway port allocation" tests). This test asserts a local-Docker Hermes deployment allocates BOTH a gateway/runtime host port and a dashboard host port. Match the file's existing harness for driving `handleDeployment`/allocation; the key assertion:

```js
  it("allocates a dashboard host port for local Docker Hermes", async () => {
    const allocations = [];
    const allocateGatewayPort = jest.fn(async ({ purpose }) => {
      const port = purpose === DASHBOARD_PORT_PURPOSE ? 19044 : 19500;
      allocations.push({ purpose: purpose || GATEWAY_PORT_PURPOSE, port });
      return port;
    });

    await runLocalHermesAllocation({ allocateGatewayPort }); // harness helper — see below

    const purposes = allocations.map((a) => a.purpose);
    expect(purposes).toContain(GATEWAY_PORT_PURPOSE);
    expect(purposes).toContain(DASHBOARD_PORT_PURPOSE);
  });
```

If the existing test file has no reusable full-deployment harness, prefer a focused unit test that imports and calls the smallest exported allocation helper. If allocation is inlined in `handleDeployment` (not separately exported), assert at the `provisioner.create` boundary instead:

```js
  it("passes both gatewayHostPort and dashboardHostPort to create() for local Docker Hermes", async () => {
    const { provisioner } = await deployLocalHermesAgent(); // existing harness
    const createArgs = provisioner.create.mock.calls[0][0];
    expect(createArgs.gatewayHostPort).toEqual(expect.any(Number));
    expect(createArgs.dashboardHostPort).toEqual(expect.any(Number));
  });
```

Use whichever harness already exists in the file; do not invent new global test infrastructure.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-api && npx jest __tests__/provisioning.test.ts -t "dashboard host port for local Docker Hermes"`
Expected: FAIL — today `allocatedDashboardPort` is only set for `remote-docker` + hermes, so `DASHBOARD_PORT_PURPOSE` is never requested / `dashboardHostPort` is `undefined`.

- [ ] **Step 3: Broaden `usesLocalDockerPublishedPort`**

In `workers/provisioner/worker.ts` (~line 3804), change:

```js
        const usesLocalDockerPublishedPort =
          deployTarget === "docker" && resolvedRuntimeFields.runtime_family === "openclaw";
```

to (all local-Docker families now publish host ports):

```js
        const usesLocalDockerPublishedPort = deployTarget === "docker";
```

- [ ] **Step 4: Allocate the dashboard port for local-Docker Hermes**

In the same block (~line 3820), change the dashboard allocation condition so it fires for BOTH remote-docker and local docker Hermes:

```js
          // Hermes needs a SECOND published host port for its dashboard UI
          // (9119), distinct from the runtime API port (8642 = the 'gateway'
          // slot used for the readiness probe). Remote publishes it on the
          // remote host; local Docker publishes it on DOCKER_AGENT_BIND_IP so
          // the embedded WebUI is reachable by external clients too.
          if (
            (deployTarget === "remote-docker" || deployTarget === "docker") &&
            resolvedRuntimeFields.runtime_family === "hermes"
          ) {
            allocatedDashboardPort = await allocateGatewayPort({
              hostKey: allocationHostKey,
              agentId: id,
              purpose: DASHBOARD_PORT_PURPOSE,
            });
          }
```

Leave the OpenClaw `remote-docker` runtime-port allocation block immediately below unchanged.

- [ ] **Step 5: Guard the dashboard port against host collisions**

Local Docker (unlike remote) shares the host with the control plane, so also exclude already-bound host ports. Immediately after the `allocateGatewayPort({ purpose: DASHBOARD_PORT_PURPOSE })` call, when `deployTarget === "docker"`, re-check and reallocate if bound:

```js
            if (
              deployTarget === "docker" &&
              typeof provisioner?.isHostPortBound === "function" &&
              (await provisioner.isHostPortBound(allocatedDashboardPort, {
                ignoreContainerName: container_name,
              }))
            ) {
              console.warn(
                `[provisioner] Dashboard host port ${allocatedDashboardPort} already bound; reallocating for agent ${id}`,
              );
              allocatedDashboardPort = await reallocateGatewayPort({
                hostKey: allocationHostKey,
                agentId: id,
                previousPort: allocatedDashboardPort,
                purpose: DASHBOARD_PORT_PURPOSE,
              });
            }
```

Verify `reallocateGatewayPort` accepts a `purpose` argument; if it does not, add `purpose` support to it (it is defined alongside `allocateGatewayPort` in the same module) so dashboard reallocations don't collide with the gateway purpose. Keep the change minimal and covered by Step 1's test intent.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend-api && npx jest __tests__/provisioning.test.ts -t "local Docker Hermes"`
Expected: PASS.

- [ ] **Step 7: Run the full provisioning suite (regression guard)**

Run: `cd backend-api && npx jest __tests__/provisioning.test.ts`
Expected: PASS — OpenClaw allocation, remote-docker allocation, and the gateway retry path are unaffected.

- [ ] **Step 8: Commit**

```bash
git add workers/provisioner/worker.ts backend-api/__tests__/provisioning.test.ts
git commit -m "feat(worker): allocate + collision-check dashboard host port for local Docker Hermes"
```

---

### Task 3: Surface the external connect address + API key on the `hermes-ui` response

Add a `connect` block to the `GET /:id/hermes-ui` runtime-info response for local-Docker Hermes agents: the externally-reachable runtime API URL, dashboard URL, and API key.

**Files:**
- Modify: `backend-api/routes/agents.ts` — add `resolveHermesConnectInfo(agent, req)` helper and include its result at the `res.json({...})` in the `/:id/hermes-ui` handler (~line 1351)
- Test: `backend-api/__tests__/hermesUi.test.ts`

**Interfaces:**
- Consumes: `resolvePublishedGatewayHost(req)` (string host), `resolvePublishedGatewayProtocol(req)` (`"http"|"https"`), `resolveHermesApiToken(agent)` (async → decrypted API key string|null), `buildAgentRuntimeFields(agent)` (`{ backend_type, deploy_target, runtime_family }`), `agent.container_id`. Both published host ports are read by inspecting the live container bindings (`8642/tcp`, `9119/tcp`) — nothing is read from persisted port columns.
- Produces: `resolveHermesConnectInfo(agent, req)` → `Promise<{ runtimeApiUrl: string, dashboardUrl: string|null, apiKey: string|null } | null>` (null when not a running local-Docker Hermes agent, or when the runtime-API port is not published). The `hermes-ui` JSON gains `connect: <that object>` when non-null.

- [ ] **Step 1: Write the failing test**

Add to `backend-api/__tests__/hermesUi.test.ts` (follow the file's existing mock setup for `fetchHermesApi`, `resolveHermesApiToken`, and the route harness). Test that a running local-Docker Hermes agent yields a `connect` block using the forwarded host and the published ports:

```js
  it("returns a connect block for a running local Docker Hermes agent", async () => {
    // agent persisted with the published runtime-API host port; dashboard host
    // port is inspected on demand from the container bindings.
    const agent = {
      id: "agent-hermes-local",
      user_id: "user-1",
      container_id: "nora-hermes-local-1",
      backend_type: "docker",
      deploy_target: "docker",
      runtime_family: "hermes",
      status: "running",
      host: "172.18.0.11",
      runtime_host: "172.18.0.11",
      runtime_port: 8642,
      gateway_token: "enc:tok",
    };
    mockResolveHermesApiToken.mockResolvedValue("secret-api-key");
    // Live container bindings: 8642 -> host 19500, 9119 -> host 19044.
    mockInspect.mockResolvedValue({
      NetworkSettings: {
        Ports: {
          "8642/tcp": [{ HostIp: "100.71.115.105", HostPort: "19500" }],
          "9119/tcp": [{ HostIp: "100.71.115.105", HostPort: "19044" }],
        },
      },
    });

    const res = await getHermesUi(agent, {
      headers: { "x-forwarded-host": "100.71.115.105" },
    });

    expect(res.connect).toEqual({
      runtimeApiUrl: "http://100.71.115.105:19500",
      dashboardUrl: "http://100.71.115.105:19044",
      apiKey: "secret-api-key",
    });
  });

  it("omits the connect block for non-Docker Hermes agents", async () => {
    const agent = {
      id: "agent-hermes-k8s",
      user_id: "user-1",
      container_id: "nora-hermes-k8s-1",
      backend_type: "k8s",
      deploy_target: "k8s",
      runtime_family: "hermes",
      status: "running",
      runtime_host: "runtime.internal",
      runtime_port: 8642,
    };

    const res = await getHermesUi(agent, { headers: {} });
    expect(res.connect).toBeUndefined();
  });
```

Wire `mockInspect` to whatever seam the file uses for `dockerode` (`docker.getContainer(...).inspect()`); if the test file already mocks dockerode for another inspect path, reuse that mock. `getHermesUi(agent, req)` is the file's existing helper for invoking the route with a stub agent + request; if it does not exist, invoke the route handler the same way the surrounding tests do.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-api && npx jest __tests__/hermesUi.test.ts -t "connect block"`
Expected: FAIL — the response has no `connect` field.

- [ ] **Step 3: Add the `resolveHermesConnectInfo` helper**

In `backend-api/routes/agents.ts`, near `resolvePublishedGatewayHost`/`resolvePublishedGatewayProtocol` (~line 537), add:

```js
// Externally-reachable connect info for Hermes Desktop / direct clients on a
// LOCAL Docker agent. Nora's own traffic uses the compose-network address
// (runtime_host:runtime_port); this is the host-published address instead:
//   runtime API  -> DOCKER_AGENT_BIND_IP:<published 8642 host port>
//   dashboard    -> DOCKER_AGENT_BIND_IP:<published 9119 host port>
// Both host ports are read by inspecting the live container bindings (never
// persisted — persisting the dashboard host port would corrupt the embed
// proxy's resolveHermesDashboardAddress). The host shown to the operator is
// whatever they browsed Nora on (X-Forwarded-Host / GATEWAY_HOST), matching
// the OpenClaw ui-info pattern.
async function resolveHermesConnectInfo(agent, req) {
  const runtimeFields = buildAgentRuntimeFields(agent);
  if (runtimeFields.runtime_family !== "hermes") return null;
  if (runtimeFields.deploy_target !== "docker") return null;
  if (!agent.container_id) return null;

  let runtimeApiHostPort = null;
  let dashboardHostPort = null;
  try {
    const Docker = require("dockerode");
    const docker = new Docker({ socketPath: "/var/run/docker.sock" });
    const info = await docker.getContainer(agent.container_id).inspect();
    const ports = info.NetworkSettings?.Ports || {};
    const runtimeBinding = ports[`${HERMES_RUNTIME_PORT}/tcp`];
    const dashboardBinding = ports[`${HERMES_DASHBOARD_PORT}/tcp`];
    runtimeApiHostPort = runtimeBinding?.[0]?.HostPort
      ? parseInt(runtimeBinding[0].HostPort, 10)
      : null;
    dashboardHostPort = dashboardBinding?.[0]?.HostPort
      ? parseInt(dashboardBinding[0].HostPort, 10)
      : null;
  } catch (err) {
    console.warn(
      `[hermes-connect] Could not inspect published ports for agent ${agent.id}: ${err.message}`,
    );
    return null;
  }

  // No published runtime API port means the operator has not exposed it
  // (DOCKER_AGENT_BIND_IP not set to a routable interface, or ports absent).
  if (!runtimeApiHostPort) return null;

  const proto = resolvePublishedGatewayProtocol(req);
  const host = resolvePublishedGatewayHost(req);
  const apiKey = await resolveHermesApiToken(agent);

  return {
    runtimeApiUrl: `${proto}://${host}:${runtimeApiHostPort}`,
    dashboardUrl: dashboardHostPort ? `${proto}://${host}:${dashboardHostPort}` : null,
    apiKey: apiKey || null,
  };
}
```

Define `HERMES_RUNTIME_PORT = 8642` as a local const in this file (or import it), and ensure `HERMES_DASHBOARD_PORT` is imported from `agent-runtime/lib/contracts` (add it to the existing contracts import if absent).

Note on the local-vs-remote gate: this uses `runtimeFields.deploy_target === "docker"`. Confirm `buildAgentRuntimeFields` exposes `deploy_target`; if it only exposes `backend_type`, gate on `backend_type === "docker"` instead (local Docker agents have `backend_type === "docker"`, remote have `remote-docker`).

- [ ] **Step 4: Include `connect` in the `hermes-ui` response**

In the `/:id/hermes-ui` handler, just before the final `res.json({...})` (~line 1351), compute:

```js
    const connect = await resolveHermesConnectInfo(agent, req);
```

and add to the response object (spread so it is omitted when null):

```js
    res.json({
      url: runtimeUrlForAgent(agent, "/v1"),
      runtime: runtimeAddress,
      health,
      dashboard,
      models,
      defaultModel: configuredModel || models[0]?.id || null,
      configuredModel,
      configuredProvider,
      configuredBaseUrl,
      directoryUpdatedAt,
      ...(connect ? { connect } : {}),
      ...(gateway ? { gateway } : {}),
      ...(modelsError ? { modelsError } : {}),
      ...(gatewayError ? { gatewayError } : {}),
    });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend-api && npx jest __tests__/hermesUi.test.ts -t "connect block"`
Expected: PASS.

- [ ] **Step 6: Add the embed-proxy regression guard in `agentEndpoints.test.ts`**

This locks in the constraint that a local Hermes agent's embed address stays on the compose network (`dashboard_port` is never the host port). Add to `backend-api/__tests__/agentEndpoints.test.ts`:

```js
  it("resolves a local Hermes dashboard on the compose network, not a host port", () => {
    // dashboard_port stays null for local Docker, so the resolver falls back to
    // the compose runtime_host + the container port 9119 (HERMES_DASHBOARD_PORT).
    const agent = {
      runtime_family: "hermes",
      deploy_target: "docker",
      runtime_host: "172.18.0.11",
      runtime_port: 8642,
      dashboard_port: null,
    };
    expect(resolveHermesDashboardAddress(agent)).toEqual({
      host: "172.18.0.11",
      port: HERMES_DASHBOARD_PORT,
    });
  });
```

Import `resolveHermesDashboardAddress` and `HERMES_DASHBOARD_PORT` the same way the file's existing tests do.

- [ ] **Step 7: Run the endpoint + resolver suites**

Run: `cd backend-api && npx jest __tests__/hermesUi.test.ts __tests__/agentEndpoints.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend-api/routes/agents.ts backend-api/__tests__/hermesUi.test.ts backend-api/__tests__/agentEndpoints.test.ts
git commit -m "feat(api): expose Hermes external connect address + API key on hermes-ui"
```

---

### Task 4: "Connect Hermes Desktop" card in the Status panel

Render `runtimeInfo.connect` as a card with copyable runtime API URL, dashboard URL, and API key.

**Files:**
- Modify: `frontend-dashboard/components/agents/hermes/StatusPanel.tsx` (add the card after the existing "Runtime API" section, ~line 494-518; `Key` and `Server` icons are already imported)

**Interfaces:**
- Consumes: `runtimeInfo.connect` → `{ runtimeApiUrl: string, dashboardUrl: string|null, apiKey: string|null }` (from Task 3); `useToast()` (already imported) for copy feedback.
- Produces: UI only. No exported interface.

- [ ] **Step 1: Add a copy helper and read `connect` near the other `runtimeInfo` reads**

In the component body (near `const runtimeReady = Boolean(runtimeInfo?.health?.ok);`, ~line 209), add:

```jsx
  const connect = runtimeInfo?.connect || null;
  const copyValue = async (label, value) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast?.success?.(`${label} copied`);
    } catch {
      toast?.error?.(`Could not copy ${label}`);
    }
  };
```

Confirm the toast handle name matches the file's `useToast()` destructure (e.g. `const toast = useToast();` or `const { success, error } = useToast();`) and adapt the calls accordingly.

- [ ] **Step 2: Render the card**

Immediately after the closing `</section>` of the existing "Runtime API" card (the `<section>` starting ~line 495), add:

```jsx
        {connect ? (
          <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3">
              <p className="text-sm font-bold text-slate-900">Connect Hermes Desktop</p>
              <p className="mt-1 text-xs text-slate-500">
                Point Hermes Desktop (or any direct client) at this address. Reachable only on the
                interface Nora publishes agent ports to (DOCKER_AGENT_BIND_IP).
              </p>
            </div>
            <div className="space-y-3 p-4">
              <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <Server size={16} className="mt-0.5 shrink-0 text-slate-500" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
                    Runtime API
                  </p>
                  <button
                    type="button"
                    onClick={() => copyValue("Runtime API URL", connect.runtimeApiUrl)}
                    className="mt-1 block w-full break-all text-left text-sm font-medium text-slate-800 hover:text-slate-950"
                  >
                    {connect.runtimeApiUrl}
                  </button>
                </div>
              </div>

              {connect.dashboardUrl ? (
                <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <Workflow size={16} className="mt-0.5 shrink-0 text-slate-500" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
                      Dashboard
                    </p>
                    <button
                      type="button"
                      onClick={() => copyValue("Dashboard URL", connect.dashboardUrl)}
                      className="mt-1 block w-full break-all text-left text-sm font-medium text-slate-800 hover:text-slate-950"
                    >
                      {connect.dashboardUrl}
                    </button>
                  </div>
                </div>
              ) : null}

              {connect.apiKey ? (
                <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <Key size={16} className="mt-0.5 shrink-0 text-slate-500" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
                      API Key
                    </p>
                    <button
                      type="button"
                      onClick={() => copyValue("API key", connect.apiKey)}
                      className="mt-1 block w-full break-all text-left font-mono text-sm font-medium text-slate-800 hover:text-slate-950"
                    >
                      Click to copy API key
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}
```

`Workflow`, `Server`, and `Key` are already imported at the top of the file.

- [ ] **Step 3: Typecheck / build the dashboard**

Run: `cd frontend-dashboard && npx tsc --noEmit` (or `npm run build` if the project has no standalone typecheck script).
Expected: no new type errors from `StatusPanel.tsx`.

- [ ] **Step 4: Manual visual check**

With the stack running and a local Hermes agent deployed (`DOCKER_AGENT_BIND_IP` set), open the agent's Status tab and confirm the "Connect Hermes Desktop" card renders the URLs and an API-key copy control, and that clicking copies (toast fires). The card is absent for a k8s/Proxmox Hermes agent.

- [ ] **Step 5: Commit**

```bash
git add frontend-dashboard/components/agents/hermes/StatusPanel.tsx
git commit -m "feat(dashboard): add Connect Hermes Desktop card to Status panel"
```

---

### Task 5: Config, comments, and docs

Document that `DOCKER_AGENT_BIND_IP` now governs Hermes and how to expose an agent to external desktop clients.

**Files:**
- Modify: `.env.example:292-295` (the `DOCKER_AGENT_BIND_IP` block)
- Modify: `workers/provisioner/backends/hermes.ts` (the `_hermesPortBindings` comment — already updated in Task 1; verify it no longer claims local Hermes "publishes nothing")
- Modify: `CLAUDE.md` (Key ports / nginx notes if they state local Hermes is compose-network-only) and `workers/provisioner/backends/README.md` if it documents port publishing

**Interfaces:** None (docs/config only).

- [ ] **Step 1: Update `.env.example`**

Replace the `DOCKER_AGENT_BIND_IP` block (~lines 292-295) with:

```
# Docker-published agent gateway/runtime ports bind to loopback by default.
# This governs ALL local Docker runtime families (OpenClaw gateway/runtime and
# Hermes runtime API 8642 + dashboard 9119). To let an external client — e.g.
# Hermes Desktop over Tailscale — reach an agent, set this to a routable host
# interface (your Tailscale IP, e.g. 100.71.115.105). Never use 0.0.0.0 without
# a firewall or authenticated reverse proxy in front.
DOCKER_AGENT_BIND_IP=127.0.0.1
```

- [ ] **Step 2: Update architecture docs**

In `CLAUDE.md`, if any line states local Hermes is reachable only via the compose network, amend it to note the runtime API (8642) and dashboard (9119) are published to `DOCKER_AGENT_BIND_IP` for external clients, while Nora's own proxy/probe traffic stays on the compose network. Update `workers/provisioner/backends/README.md` similarly if it documents Hermes port behavior. Make the smallest accurate edits; do not restructure the docs.

- [ ] **Step 3: Verify no stale "publishes nothing" claims remain**

Run: `grep -rn "publishes nothing\|reached via the container IP" workers/provisioner/backends/ CLAUDE.md .env.example`
Expected: the only remaining references describe the **remote** variant contract or are inside `remote-hermes.ts` — no claim that the *base/local* Hermes publishes nothing.

- [ ] **Step 4: Commit**

```bash
git add .env.example CLAUDE.md workers/provisioner/backends/README.md
git commit -m "docs: DOCKER_AGENT_BIND_IP now governs Hermes local Docker port publishing"
```

---

## Final Verification

- [ ] `cd backend-api && npm test` — full backend suite green.
- [ ] `cd frontend-dashboard && npx tsc --noEmit` — no new type errors.
- [ ] End-to-end: deploy a local Docker Hermes agent with `DOCKER_AGENT_BIND_IP=<tailscale-ip>`; `docker inspect <container>` shows `8642/tcp` and `9119/tcp` published on that IP; the Status tab's "Connect Hermes Desktop" card shows a reachable URL + key; Hermes Desktop connects over Tailscale.
- [ ] Regression: in-Nora Hermes chat, dashboard embed, and readiness still work (compose-network path unchanged).
- [ ] Regression: an OpenClaw local Docker agent and a remote Hermes agent are unaffected.
