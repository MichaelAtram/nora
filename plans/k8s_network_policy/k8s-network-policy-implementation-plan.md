# Kubernetes Network Policy Implementation Plan

## Purpose

This document translates the Kubernetes network-policy manifest into an engineer-facing execution
sequence. It is intended to be detailed enough that an engineer new to this codepath can use it as
a working skeleton for the feature.

The full feature has three staged goals:

1. Add backend enforcement of namespace-local Kubernetes `NetworkPolicy` for Nora-managed k8s
   runtimes.
2. Add Admin read-only visibility into Kubernetes deployment and policy state.
3. Add Admin policy management controls for future outbound restriction editing and related
   lifecycle actions.

Important scope note:

- the baseline backend-enforcement work in this document is the primary implemented feature
- the later editable-management work is now expanded in
  `plans/k8s_network_policy/k8s-network-policy-management-plan.md`
- readers should use this implementation plan for the baseline enforcement path and the management
  plan for follow-on operator-authored policy editing

## Design Decisions (Locked For V1) & Code Facts

The decisions below are settled for v1; the phases assume them. The code facts are verified against
current source and are referenced by the phases. Nothing here is pending — it is background the phases
build on.

### Locked decisions

These were decided for v1. The phases below assume them.

1. **Unsupported-cluster behavior** (manifest Remaining Question #3): **deploy as degraded.** When
   `supportsNetworkPolicy` is false, allow the deploy, skip k8s policy creation, mark the runtime
   `degraded`, surface a machine-readable issue on the target, and rely on the NemoClaw/OpenShell
   runtime layer for outbound control. No hard-fail in v1. This defines the Admin status enum
   (`supported` / `degraded` / `unsupported`) and the deploy-path error contract.

2. **Trusted-ingress source model** (manifest Remaining Question #1): **`ipBlock` CIDR allowlist** on
   the gateway/runtime ports, not a namespace/pod selector. Rationale and the concern it answers:
   - Nora's control plane runs **outside** the cluster and reaches agents via node IPs (`node-port`),
     the LB address (`load-balancer`), or `runtimeHost`. In-cluster `namespaceSelector`/`podSelector`
     cannot match an external source, so they are not an option for v1's actual topology.
   - A "reopen ports from any source" approach is **rejected**: peer pods in the namespace would then
     reach 18789/9090, violating the pod-to-pod isolation requirement.
   - With the default `externalTrafficPolicy: Cluster`, external traffic is SNAT'd to a **node IP**
     while peer-pod traffic keeps its **pod-CIDR IP**. Allowing an `ipBlock` over the node CIDR / LB
     source range therefore admits the external control plane while excluding peer pods on those
     ports. The SNAT behavior is load-bearing here, not an obstacle.
   - Per-mode source CIDR: node CIDR for `node-port`, `loadBalancerSourceRanges` (already a profile
     field) for `load-balancer`, node/kubelet IP for `cluster-ip` reached via port-forward.
   - Safety net: the default-deny ingress policy alone blocks **all** pod-to-pod ingress on every
     port. The allow policy only adds back 2 ports from the node/LB `ipBlock`, so pod-to-pod denial
     does not depend on getting the CIDR perfectly tight. Phase 4 validates the exact CIDR and
     `externalTrafficPolicy` per mode via smoke.

3. **Capability source** (manifest Cluster Capability Model): **auto-probe**, best-effort, with the
   result stored on the profile and operator-overridable. Important honesty about limits: presence of
   the `NetworkingV1` API does **not** prove enforcement — the API exists on every cluster regardless
   of CNI. So the probe should combine signals (API availability plus CNI/policy-engine detection,
   e.g. known Cilium/Calico DaemonSets or CRDs) and treat the result as a strong hint, not proof.
   A truly authoritative check (deploy two pods and test a denied connection) is heavier and belongs
   in smoke (Phase 6), not the registration-time probe. Persist what the probe finds; let the
   operator override `supportsNetworkPolicy` / `policyEngine` if the probe is wrong.

4. **Plain OpenClaw egress posture** (manifest Remaining Question #2): **ingress-only; no egress
   policy.** The requirement is that pod-to-pod communication is denied, and that is already satisfied
   bidirectionally by default-deny ingress on every agent: agent A's egress to agent B is dropped at
   B's ingress wall. So plain OpenClaw needs no egress object in v1. Deny-by-default egress remains
   NemoClaw-only. Broader OpenClaw egress hardening stays a later, explicit decision.

5. **NemoClaw startup/runtime egress**: **coarse port-based external egress allow** — no two-phase
   apply and no image pre-bake in v1. Rationale (verified against the bootstrap):
   - The NemoClaw bootstrap reaches the network for `apt-get install git` (port 80), `npm install -g
     openclaw nemoclaw tsx` (registry + CDN, port 443), and DNS. At runtime it also reaches NVIDIA
     inference (443) and the Nora backend callback (`BACKEND_API_URL`).
   - None of these (npm CDN, NVIDIA, apt mirrors) have stable CIDRs, so they cannot be expressed as
     precise `ipBlock`s — the manifest already assigns precise hostname enforcement to OpenShell.
   - Because NVIDIA inference must stay reachable in steady state and can't be CIDR-pinned, the k8s
     egress policy must allow coarse external egress on 80/443 **permanently**. Once that exists, the
     npm/apt bootstrap (same ports) works for free, so the startup hazard dissolves. Two-phase apply
     and image pre-bake solve nothing the required steady-state coarse rule does not already solve.
   - Concrete shape: deny-by-default egress; allow DNS to `kube-system` :53; allow external egress on
     TCP 80/443 (plus the backend-callback port if external) to `0.0.0.0/0` **excluding the cluster
     pod/service CIDRs**, so pod-to-pod and cluster-internal egress stay denied while public web
     egress is permitted. OpenShell `policy.yaml` remains the precise hostname allowlist.
   - The exact `except` CIDR set, and whether to bake `git` into the image to drop the port-80 apt
     dependency, are tuning details validated in Phase 4/6 — not blockers.

### Code facts the plan depends on (verified against current source)

- The Kubernetes adapter is `workers/provisioner/backends/k8s.ts` but is authored in **CommonJS**
  (`require` / `module.exports`) and is not type-checked as TypeScript. Policy builders should be
  plain object factories shaped like `V1NetworkPolicy`; do not assume compile-time typing.
- The adapter currently instantiates only `CoreV1Api`, `AppsV1Api`, and `CustomObjectsApi`
  (`k8s.ts` constructor). **`NetworkingV1Api` must be added** to create/read `NetworkPolicy` objects.
- Today's pod template stamps `app=openclaw-agent`, `nora.agent.id`, `nora.runtime.family=openclaw`,
  `nora.execution.target`, `nora.kubernetes.cluster`, and `openclaw.agent.id`. There is **no label
  that distinguishes a NemoClaw-profile pod** — `isNemoClaw` exists only as a local deploy-time flag.
  A sandbox-profile label must be added to the pod template before egress policies can target
  NemoClaw pods (see Phase 0).
- Group vs per-agent selection: `app=openclaw-agent` (or `nora.runtime.family=openclaw`) selects the
  whole Nora-managed agent set in a namespace; `openclaw.agent.id` / `nora.agent.id` select one
  agent. Baseline policies target the **group**, never a single agent.
- The Hermes runtime family is **in scope** for v1 ingress isolation. It is deployed via
  `_createHermes(...)` (routed from `create()` when `runtimeFamily === "hermes"`) and is structurally
  like plain OpenClaw, with three mechanical differences the builders must account for:
  - group selector `app=hermes-agent` (Hermes pods do not carry `openclaw.agent.id`),
  - app ports runtime `8642` (`HERMES_RUNTIME_PORT`) and dashboard `9119` (`HERMES_DASHBOARD_PORT`),
    not gateway `18789` / runtime `9090`,
  - namespace `runtimeNamespaces.hermes` (the profile's `hermesNamespace`), which **falls back to the
    OpenClaw namespace when unset** — so Hermes and OpenClaw can co-reside, which is exactly why
    Hermes must be covered (an uncovered Hermes pod would be an unprotected peer).
  Hermes gets shared ingress isolation only; it has no NemoClaw/OpenShell egress contract, so no
  deny-by-default egress in v1 (same posture as plain OpenClaw).

## Existing Code To Reuse

### Backend / Control Plane

- `backend-api/kubernetesClusters.ts`
  Owns Kubernetes cluster registration, normalization, exposure modes, and execution-target profile
  shape.
- `agent-runtime/lib/backendCatalog.ts`
  Owns deploy-target availability, execution-target entries, issues, and runtime/sandbox metadata.
- `workers/provisioner/worker.ts`
  Owns backend loading and deploy-time runtime-field resolution.
- `workers/provisioner/backends/k8s.ts`
  Owns Kubernetes namespace, ConfigMap, Deployment, Service, status, logs, exec, and destroy
  lifecycle behavior.
- `backend-api/containerManager.ts`
  Owns backend-agnostic lifecycle routing used by the API after deploy.
- `agent-runtime/lib/agentEndpoints.ts`
  Owns how backend-api resolves runtime/gateway hosts and ports for deployed agents.

### Runtime Policy Reference

- `workers/provisioner/backends/nemoclaw.ts`
  Owns the current baseline NemoClaw/OpenShell runtime policy posture and the approved outbound
  destination categories that already exist today.

### Admin / Frontend Reference

- Admin cluster registration flows and current deployment-related surfaces under
  `backend-api/routes/admin.ts` and the corresponding admin/frontend screens.
- Existing Admin/runtime pages that already show deployment status or lifecycle actions should be
  used as styling and interaction references when the policy UI work begins.

### Test / Smoke Reference

- existing backend tests around cluster normalization and agent deploy-target handling
- `backend-api/__tests__/agents.test.ts`
- `backend-api/__tests__/controlPlane.test.ts`
- `backend-api/__tests__/kubernetesClusters.test.ts`
- `e2e/scripts/k8s-smoke.mts`
  as the base for policy-aware smoke coverage

## Stage A: Backend Enforcement Foundation

This stage is the mandatory foundation for everything else. It creates the real backend contract
that later Admin UI work will surface.

### Phase 0: Stamp A Sandbox-Profile Label On Pods (Prerequisite)

#### Objective

Make NemoClaw-profile pods selectable by label so the egress bundle in Phase 2/3 has something to
target. This must land before any egress policy work.

#### Files

- `workers/provisioner/backends/k8s.ts`

#### Changes

1. Add a deterministic sandbox-profile label (e.g. `nora.sandbox.profile`) to the OpenClaw k8s
   Deployment metadata, the pod template metadata, and the bootstrap ConfigMap labels. The value is
   derived from the already-present `isNemoClaw` flag in the deploy method:
   - `nora.sandbox.profile=nemoclaw` when `isNemoClaw` is true
   - `nora.sandbox.profile=standard` otherwise
2. Do **not** add the label to the Deployment `spec.selector.matchLabels` — that selector is immutable
   after creation and is keyed on `openclaw.agent.id` today. The sandbox label belongs in the
   metadata labels only, which is what `NetworkPolicy` podSelectors match against.
3. Confirm the label flows from `config.sandboxProfile` for both initial deploy and redeploy paths.
   Note the routing fact: NemoClaw-on-k8s is `(backend=k8s, sandbox_profile=nemoclaw)` and reaches the
   k8s adapter via `isNemoClaw`; the `docker:nemoclaw` mapping in `worker.ts` only applies when the
   backend is docker, so it does not interfere.

4. Coverage caveat: already-running pods do not gain this label until they are redeployed. Since v1
   creates policies at deploy time, the label and the matching policy land together on new/redeployed
   pods; pre-existing runtimes are only covered after a redeploy. State this so no one expects
   retroactive enforcement.

#### Functions

- `create(config)` (`k8s.ts`) — **change**. Add `nora.sandbox.profile` to the three label maps it
  already builds: the Deployment `metadata.labels`, the pod `template.metadata.labels`, and the
  labels passed to `_upsertBootstrapConfigMap(...)`. Value derived from the existing `isNemoClaw`
  local. Do not touch `spec.selector.matchLabels`.
- `_sandboxProfileLabelValue(isNemoClaw)` (`k8s.ts`) — **new, optional**. Tiny helper returning
  `"nemoclaw" | "standard"` to avoid repeating the ternary at the three label sites. Skip if inlining
  reads cleaner.
- `_createHermes(config, deployName)` (`k8s.ts`) — **no change in this phase**. Hermes has no
  NemoClaw sandbox profile, so it needs no `nora.sandbox.profile` label. Its ingress isolation is
  wired in Phase 3 via the `app=hermes-agent` group selector; the policy work, not a pod label, is
  what brings it into scope.

#### Tests

- nemoclaw deploy stamps `nora.sandbox.profile=nemoclaw` on the pod template
- standard openclaw deploy stamps `nora.sandbox.profile=standard`
- the Deployment selector is unchanged (no immutable-selector regression on redeploy)

### Phase 1: Extend The Kubernetes Cluster Capability Model

#### Objective

Teach Nora whether a registered Kubernetes execution target supports baseline Kubernetes
`NetworkPolicy`, store that metadata on the cluster/execution-target profile, and fail or degrade
cleanly when a secured deployment is requested on a target that cannot enforce it.

#### Files

- `backend-api/kubernetesClusters.ts`
- `agent-runtime/lib/backendCatalog.ts`
- relevant backend tests for cluster/profile normalization and execution-target status

#### Changes

1. Extend the Kubernetes cluster profile shape in `backend-api/kubernetesClusters.ts` so the stored
   profile can carry policy-support metadata such as:
   - `supportsNetworkPolicy: boolean`
   - `policyEngine: string | null`

   This requires a **schema migration** — the `kubernetes_clusters` table has neither column today.
   Follow the existing pattern: add the columns to `backend-api/db_schema.sql` for fresh installs AND
   add idempotent `ALTER TABLE kubernetes_clusters ADD COLUMN …` statements in the migration block in
   `backend-api/server.ts` for existing installs. Default conservatively (e.g. `supports_network_policy`
   defaults to false/unknown). Update the create/update SQL and the parameter list accordingly.

2. Update profile normalization / serialization so this metadata survives:
   - create/update requests
   - DB row to in-memory profile conversion
   - API responses that expose execution-target details

3. Thread the new metadata into the execution-target/backend catalog path so a selected Kubernetes
   target knows whether baseline `NetworkPolicy` is available.

4. Auto-probe capability at cluster registration (create/update) per locked decision #3, and persist
   the result on the profile. **Extend the existing cluster connection-test path** rather than
   inventing a new mechanism: `backend-api/kubernetesClusters.ts` already builds a client
   (`buildKubeConfig` + `coreApi.listNamespace`) and records `last_test_status`. Add the probe there:
   - probe `NetworkingV1` API availability plus a best-effort CNI/policy-engine signal (known
     Cilium/Calico DaemonSets or CRDs) to set `policyEngine`
   - probe RBAC for `networking.k8s.io/networkpolicies` (get/create/patch) using a `SelfSubjectAccessReview`;
     lack of these verbs means policy creation will 403 at deploy, so treat it as not-supported
   - treat the probe as a strong hint, not proof — API presence alone does not prove enforcement
   - allow the operator to override the stored `supportsNetworkPolicy` / `policyEngine` values
   - default conservatively when the probe is inconclusive (treat as "unknown/unsupported" rather
     than silently assuming support)

5. Add a target-support check used during secured runtime selection/deploy validation. Per locked
   decision #1:
   - if the target supports `NetworkPolicy`, continue normally
   - if the target does not support it, surface a machine-readable issue on the target, skip policy
     creation, and mark the runtime `degraded` (no hard-fail)

6. Keep the v1 model intentionally simple: Nora only needs to know whether the target can enforce
   standard Kubernetes `NetworkPolicy`, not every engine-specific extension.

Do not add engine-specific feature flags in v1 beyond identifying the engine family. The goal is to
know whether the cluster can enforce the baseline shared policy model, not to fully model Cilium vs
Calico vs other feature deltas yet.

#### Functions

Schema (not functions, but required first): add `supports_network_policy` and `policy_engine`
columns to `kubernetes_clusters` in `db_schema.sql`, plus idempotent `ALTER TABLE … ADD COLUMN`
statements in the migration block of `backend-api/server.ts`.

In `backend-api/kubernetesClusters.ts`:

- `rowToProfile(row, opts)` — **change**. Map the two new columns onto the profile as
  `supportsNetworkPolicy` / `policyEngine`.
- `normalizeClusterInput(input, existing)` — **change**. Accept/normalize the two fields from
  create/update payloads (coerce bool/string, default conservatively, allow operator override).
- `createKubernetesCluster(input)` and `updateKubernetesCluster(clusterId, input)` — **change**. Add
  the two columns to the INSERT/UPDATE SQL and their parameter lists.
- `maskCluster(row)` — **change** (if it field-whitelists). Include the two fields in API output.
- `probeNetworkPolicyCapability(kc, k8s)` — **new**. Given a loaded `KubeConfig`, return
  `{ supportsNetworkPolicy, policyEngine }` from three signals: NetworkingV1 API presence, a
  `SelfSubjectAccessReview` for `networkpolicies` get/create/patch, and best-effort CNI detection
  (list DaemonSets / CRDs for calico/cilium). Returns a hint, not proof.
- `testKubernetesCluster(clusterId)` — **change**. After the existing `coreApi.listNamespace`
  reachability check, call `probeNetworkPolicyCapability(...)` with the same `kc` and persist the
  result alongside `last_test_status`. This is where auto-probe lives (locked decision #3).
- `assertKubernetesExecutionTargetAvailable(runtimeFields)` — **no functional change**. It must not
  hard-fail on missing policy support (decision #1); the returned profile already carries
  `supportsNetworkPolicy` via `rowToProfile`, which the deploy path reads.

In `agent-runtime/lib/backendCatalog.ts`:

- `getExecutionTargetMetadata(deployTarget, env)` and/or `baseDeployTargetIssue(...)` — **change**.
  Fold policy capability into execution-target metadata/issue assembly so the catalog can surface a
  `supported | degraded | unsupported` status to callers.

#### Tests

- cluster profile normalizes the new fields correctly
- execution target surfaces missing-policy-support issue cleanly
- legacy clusters without explicit capability data remain backward-compatible

### Phase 2: Normalize The Shared Policy Model

#### Objective

Create one explicit internal model for the baseline policy bundle Nora wants to manage per runtime
namespace, instead of spreading selectors, names, ports, and policy-object definitions across ad
hoc code branches.

#### Files

- `workers/provisioner/backends/k8s.ts`
- optionally a small extracted helper module under `workers/provisioner/backends/` if the policy
  builders become too large

#### Changes

1. Add policy-builder helpers in `workers/provisioner/backends/k8s.ts` that return plain JavaScript
   objects shaped like Kubernetes `V1NetworkPolicy`. They are CommonJS object factories (this file is
   not type-checked), submitted directly by the client — not raw YAML stored in the repo. Add a
   `NetworkingV1Api` client in the adapter constructor; it does not exist yet.

2. Centralize the selectors/constants those builders use. These are **family-keyed**, because
   OpenClaw and Hermes differ in group selector and ports:
   - **group selector** per family — `app=openclaw-agent` for OpenClaw/NemoClaw,
     `app=hermes-agent` for Hermes (equivalently keyed on `nora.runtime.family`). This — not
     `openclaw.agent.id` / `nora.agent.id` — is what baseline policies match.
   - **app ports** per family — OpenClaw gateway `18789` + runtime `9090`; Hermes runtime `8642`
     (`HERMES_RUNTIME_PORT`) + dashboard `9119` (`HERMES_DASHBOARD_PORT`).
   - **NemoClaw selector**: `nora.sandbox.profile=nemoclaw` (added in Phase 0), combined with the
     OpenClaw group selector. NemoClaw is an OpenClaw sandbox profile only — it never applies to
     Hermes.
   - the trusted-source `ipBlock` CIDR used for allowed ingress, resolved per exposure mode (locked
     decision #2): node CIDR for `node-port`, `loadBalancerSourceRanges` for `load-balancer`,
     node/kubelet IP for `cluster-ip`. This is family-independent (it describes the external caller,
     not the protected pod).

3. Reuse the labels Nora already stamps onto Deployments/Pods (plus the Phase 0 sandbox label) rather
   than introducing a second pod identity scheme just for policy matching.

4. Make policy names deterministic so deploy/redeploy can always perform create-or-replace against
   the same object names.

5. Make the rule direction explicit in the helper structure:
   - protected destination pods are selected with `podSelector` (the group selector)
   - trusted callers are expressed with a source-side `ipBlock` (locked decision #2), since the
     trusted source is external to the cluster and arrives SNAT'd to a node/LB address. Do not model
     trusted callers with `namespaceSelector`/`podSelector` — those only match in-cluster sources.

#### Policy Inventory

The shared builder layer should be capable of producing objects equivalent to the following. The two
ingress objects are emitted **per family** — an OpenClaw set (`app=openclaw-agent`, ports 18789/9090)
and a Hermes set (`app=hermes-agent`, ports 8642/9119) — so a namespace hosting both families gets
two ingress pairs with distinct names. The egress objects are NemoClaw-only and never apply to Hermes.

- `nora-agent-default-deny-ingress` (openclaw) / `nora-hermes-default-deny-ingress`: namespace-local
  baseline that selects that family's agent pods and denies all inbound traffic unless another policy
  re-allows it.
- `nora-agent-allow-trusted-ingress` (openclaw) / `nora-hermes-allow-trusted-ingress`: narrow ingress
  carve-back that reopens only that family's required app ports from trusted sources.
- `nora-nemoclaw-default-deny-egress`: NemoClaw-only baseline that selects NemoClaw pods and denies
  outbound traffic unless another policy re-allows it.
- `nora-nemoclaw-allow-dns`: explicit DNS egress allow rule so deny-by-default pods can still
  resolve names. CoreDNS lives in `kube-system` (a different namespace), so this rule must allow
  egress `to` a `namespaceSelector` matching `kube-system` (label `kubernetes.io/metadata.name:
  kube-system`) on **both** UDP and TCP port 53. A pod-local rule will not reach DNS once egress is
  denied.
- `nora-nemoclaw-allow-required-internal-egress`: narrow allow rule for any Nora-required internal
  destinations that must remain reachable from a NemoClaw pod.
- `nora-nemoclaw-allow-coarse-external-egress`: **required** coarse Kubernetes-layer external egress
  allow (locked decision #5) — `0.0.0.0/0` on TCP 80/443, excluding the cluster pod/service CIDRs. It
  keeps NVIDIA inference and the package bootstrap reachable while pod-to-pod and cluster-internal
  egress stay denied; OpenShell remains the precise hostname allowlist.

These names are illustrative; the implementation can refine them, but the inventory should remain
equivalent unless the manifest changes.

#### Illustrative Rule Shapes

The implementation should not hard-code YAML strings. Instead, the builder helpers should construct
typed Kubernetes object payloads whose structure maps directly to the intended YAML:

- one namespace-local `NetworkPolicy` object per baseline rule
- `spec.podSelector.matchLabels` for the protected Nora-managed pod set
- `spec.policyTypes` set explicitly to `Ingress`, `Egress`, or both as needed
- `spec.ingress` rules that reopen only specific `ports` from trusted `from` selectors
- `spec.egress` rules that allow only specific `to` selectors / `ipBlock`s / DNS ports where
  justified

If the team wants examples in code comments or the manifest, they should reflect the exact object
shape the builders emit.

Key invariants:

- policies are namespace-local objects
- policies target pods by label (the group selector), not by pod name
- "default deny" is expressed as a policy that selects the group, declares the relevant
  `policyTypes`, and supplies an empty rule list (`ingress: []` / `egress: []`). NetworkPolicies are
  additive allow-lists: a selected pod with no matching allow rule is denied for that direction. The
  separate allow policies then carve specific traffic back in.
- default deny ingress applies to Nora-managed OpenClaw-family pods (the whole group)
- default deny egress applies to NemoClaw-selected pods only in v1
- DNS egress is explicit, not implicit

**Startup egress is covered by the coarse external-egress allow (locked decision #5).** NemoClaw pods
fetch packages at container startup (`apt-get install git` on 80, `npm install …` on 443) before the
OpenShell `policy.yaml` is active. Rather than a two-phase apply or image pre-bake, the egress bundle
includes a permanent coarse external-egress allow on TCP 80/443 (required anyway so NVIDIA inference
stays reachable, since its CDN IPs can't be CIDR-pinned). That same rule lets the bootstrap complete,
so there is no startup hazard to work around. This makes `nora-nemoclaw-allow-coarse-external-egress`
a required object, not an optional placeholder: it allows `0.0.0.0/0` on 80/443 **excluding the
cluster pod/service CIDRs**, keeping pod-to-pod and cluster-internal egress denied. OpenShell remains
the precise hostname allowlist.

#### Functions

Pure builders + constants. Put these in a new `workers/provisioner/backends/networkPolicies.ts`
module (CommonJS, exported functions) so they are unit-testable without a cluster; `k8s.ts` requires
them. All builders return plain `V1NetworkPolicy`-shaped objects.

- module constants — **new**, family-keyed: `FAMILY_GROUP_SELECTOR`
  (`{ openclaw: { app: "openclaw-agent" }, hermes: { app: "hermes-agent" } }`), `FAMILY_PORTS`
  (`{ openclaw: { gateway: 18789, runtime: 9090 }, hermes: { runtime: 8642, dashboard: 9119 } }`),
  `NEMO_SELECTOR` (OpenClaw group + `nora.sandbox.profile: nemoclaw`), and `POLICY_NAMES` (the
  deterministic names; the ingress pair is suffixed/derived per family so OpenClaw and Hermes objects
  don't collide if they share a namespace).
- `buildDefaultDenyIngressPolicy({ namespace, runtimeFamily })` — **new**. Selects that family's
  group, `policyTypes: [Ingress]`, empty `ingress`.
- `buildAllowTrustedIngressPolicy({ namespace, runtimeFamily, sourceIpBlocks })` — **new**. Reopens
  that family's app ports (from `FAMILY_PORTS`) from the `ipBlock` CIDR list.
- `buildNemoDenyEgressPolicy({ namespace })` — **new**. Selects the NemoClaw group, `policyTypes:
  [Egress]`, empty `egress`. (OpenClaw-family only; never Hermes.)
- `buildNemoAllowDnsPolicy({ namespace })` — **new**. Egress to a `kube-system` namespaceSelector on
  UDP+TCP 53.
- `buildNemoAllowExternalEgressPolicy({ namespace, excludeCidrs })` — **new, required** (locked
  decision #5). Egress to `0.0.0.0/0` on TCP 80/443 with `except: excludeCidrs` (the cluster
  pod/service CIDRs). Covers NVIDIA inference and the package bootstrap; keeps pod-to-pod and
  cluster-internal egress denied.
- `buildNemoAllowInternalEgressPolicy({ namespace, targets })` — **new, only if needed**. A narrow
  carve-back for a proven in-cluster dependency (e.g. the backend callback if it resolves to a
  cluster-internal address). Omit if the backend callback is external (covered by the rule above).
- `buildBaselinePolicyBundle({ namespace, runtimeFamily, isNemoClaw, sourceIpBlocks })` — **new**.
  Orchestrator returning the ordered array of policy objects: the ingress pair for the given family
  always; the NemoClaw egress set only when `runtimeFamily` is openclaw **and** `isNemoClaw`. This is
  the single entry point Phase 3 calls for both `create()` and `_createHermes`.

In `k8s.ts` (needs profile/exposure data, so it stays in the adapter):

- `_resolveTrustedIngressIpBlocks()` — **new**. Map the profile's exposure mode to the source CIDR
  list: node CIDR (`node-port`), `loadBalancerSourceRanges` (`load-balancer`), node/kubelet IP
  (`cluster-ip`). Feeds `sourceIpBlocks` into the bundle.

#### Tests

- policy builders produce stable selectors and names
- ingress deny policy selects Nora agent pods
- trusted ingress policy opens only intended ports
- egress deny policy selects NemoClaw pods
- DNS allow policy remains narrow and explicit

### Phase 3: Wire Policy Creation Into Kubernetes Deployment

#### Objective

Ensure Nora-managed policy resources are created as part of the Kubernetes deploy flow and managed
with the same idempotent lifecycle expectations as Services and Deployments.

#### Files

- `workers/provisioner/backends/k8s.ts`
- `workers/provisioner/worker.ts` only if minor validation or error-plumbing changes are needed

#### Changes

1. Insert a policy-reconciliation step into the Kubernetes backend deploy path in `k8s.ts`:
   - compute the runtime namespace
   - compute the runtime family / labels
   - build the required policy object set for that namespace
   - create or replace those `NetworkPolicy` objects before returning deploy success

2. Gate that reconciliation step behind the Phase 1 capability check (locked decision #1):
   - if `supportsNetworkPolicy` is true, reconcile the baseline bundle
   - if `supportsNetworkPolicy` is false, skip policy creation and mark the runtime `degraded` (no
     hard-fail)

3. Use deterministic object names plus an explicit reconcile mechanism. Do not rely on a naive
   "create or replace" — a bare create 409s on redeploy, and `replaceNamespacedNetworkPolicy`
   requires a current `resourceVersion`. Use one of:
   - read → create if 404, else `patch` the existing object, or
   - server-side apply (PATCH with the apply content-type and a stable field manager).
   Either way, redeploy must be idempotent and must pick up baseline updates.

   Ordering within the bundle: emit the default-deny ingress policy (no source dependency) alongside
   the allow-trusted-ingress policy whose `from` is the per-exposure-mode `ipBlock` (locked decision
   #2). Always emit both together — a deny without its carve-back would cut off runtime access. The
   ipBlock CIDR is resolved from the cluster profile's exposure mode at deploy time.

4. Add exact deploy-time checks/mechanisms:
   - verify the target namespace exists or create it
   - verify the required labels/selectors are present on the Deployment template so the policies
     actually match the pod
   - verify the trusted ingress rule only opens the intended ports for the selected exposure mode
   - verify NemoClaw-only egress policies are only emitted for NemoClaw deployments

5. Creation order and readiness coupling. Reconcile policies and the Deployment together, but be
   aware the post-deploy gateway/runtime readiness check reaches the pod over the ingress `ipBlock`
   from the external control plane — so a wrong CIDR or a missing carve-back surfaces as a **deploy
   failure**, not a silent misconfig. That is acceptable fail-fast behavior, but the readiness/
   reachability check must run after the allow-ingress policy exists. For NemoClaw, the egress bundle
   must include the coarse external-egress allow (locked decision #5) in the same reconcile, or
   readiness will hang on a bootstrap that can't reach the package registry.

6. Partial-failure handling. The default-deny ingress and its allow carve-back are a pair: if the
   deny is created but the allow create/patch fails, the pod is left unreachable. On a failed
   reconcile, either roll back the deny or fail the deploy with a clear error and leave the namespace
   in a known state — do not return success with a half-applied bundle.

7. RBAC failure. If policy operations 403 (the credential lacks `networkpolicies` verbs), treat it
   the same as an unsupported target (mark `degraded`, surface the issue) rather than failing
   opaquely. Ideally the Phase 1 probe already caught this.

8. Destroy behavior in v1: **do not delete the baseline policies on single-agent destroy.** They are
   namespace-scoped, label-targeted infrastructure shared by every Nora-managed pod in the namespace
   — deleting them when one agent goes away would strip protection from the survivors. Leave them in
   place. (Whole-namespace teardown, if Nora ever does it, is a separate concern out of v1 scope.)

#### Functions

All in `k8s.ts`:

- `constructor(profile)` — **change**. Add `this.networkingApi = this.kc.makeApiClient(
  k8s.NetworkingV1Api)` and read `this.supportsNetworkPolicy = profile.supportsNetworkPolicy`.
- `_createOrPatchNetworkPolicy(name, policy, namespace)` — **new**. The idempotent primitive:
  read → create if 404, else patch. Mirrors the style of `_createOrReplaceDeployment` /
  `_createOrReadService`. Reuse the existing `_isNotFoundError` / `_isAlreadyExistsError` helpers.
- `_reconcileNetworkPolicies({ namespace, runtimeFamily, isNemoClaw })` — **new**. Resolve ip blocks
  via `_resolveTrustedIngressIpBlocks()`, call `buildBaselinePolicyBundle({ namespace, runtimeFamily,
  isNemoClaw, sourceIpBlocks })`, apply each object with `_createOrPatchNetworkPolicy`, and return a
  status summary `{ attempted, succeeded, mode, degraded }`. Family-aware: it produces the OpenClaw
  ingress pair (+ NemoClaw egress when applicable) or the Hermes ingress pair. Handles partial failure
  (change #6) and RBAC 403 → degraded (change #7).
- `create(config)` — **change**. After `_ensureNamespace(namespace)` and before
  `_createOrReplaceDeployment`, if `this.supportsNetworkPolicy` call `_reconcileNetworkPolicies({
  namespace, runtimeFamily: "openclaw", isNemoClaw })`; otherwise build a `degraded` status. Pass the
  status into `_buildEndpointResult`.
- `_createHermes(config, deployName)` — **change**. Same insertion: after `_ensureNamespace(namespace)`
  and before its `_createOrReplaceDeployment`, call `_reconcileNetworkPolicies({ namespace,
  runtimeFamily: "hermes", isNemoClaw: false })` when supported, and thread the status into its
  `_buildEndpointResult`. This is the change that brings Hermes into enforcement.
- `_buildEndpointResult({ ... , policyStatus })` — **change**. Include the policy-status object in the
  returned result so the worker can persist it (Phase 5). Used by both deploy paths.
- `destroy(containerId, options)` — **change (comment only)**. Add an explicit note that baseline
  NetworkPolicies are intentionally not deleted on single-agent destroy. No call to delete them.

#### Notes

- This phase is where the feature becomes real for deployed runtimes.
- The Kubernetes backend should remain the only owner of policy object creation for this stage.
- Do not mix future Admin-editable policy semantics into this first deploy-time enforcement pass.

#### Tests

- deploy path creates policy resources before returning success
- redeploy is idempotent when policies already exist
- destroy path does not remove shared baseline policies accidentally

### Phase 4: Validate Runtime Reachability And Exposure-Mode Assumptions

#### Objective

Make sure the new Kubernetes policy layer does not break Nora's existing runtime access model, and
turn the currently open ingress-source question into a concrete backend contract.

#### Files

- `workers/provisioner/backends/k8s.ts`
- `agent-runtime/lib/agentEndpoints.ts`
- `backend-api/containerManager.ts`
- smoke / integration test paths

#### Changes

1. Validate the actual app-level access paths Nora uses today, per family:
   - OpenClaw: gateway `18789`, runtime `9090`
   - Hermes: runtime/API-server `8642`, dashboard `9119`

2. Preserve the distinction between:
   - Kubernetes control-plane lifecycle operations, which do not require broad app-port ingress
   - runtime/gateway HTTP access, which does require reachability to the exposed service path

3. Validate the trusted-ingress source model chosen in locked decision #2 against real traffic
   for each exposure mode (`cluster-ip`, `node-port`, `load-balancer`). This phase confirms the
   decision holds; it does not make it for the first time.

4. Confirm the minimum DNS and bootstrap-related egress required for NemoClaw pods.

5. Keep NemoClaw/OpenShell runtime policy as the precise outbound endpoint control layer.

6. Do not attempt to force Kubernetes `NetworkPolicy` to become the exact source of truth for
   internet destination allowlisting when plain selector/CIDR policy cannot express that intent
   cleanly.

7. Add comments or helper structure where needed so future readers understand that Kubernetes egress
   rules and NemoClaw runtime policy are intentionally aligned in posture but not expected to be a
   literal rule-for-rule translation.

#### Functions

This phase is mostly validation and comments rather than new surface area; the functions it leans on
already exist.

- `_resolveTrustedIngressIpBlocks()` (`k8s.ts`) — **validate**. Confirm the per-exposure-mode CIDR it
  returns actually admits the external control plane and excludes the pod CIDR, against real traffic.
- `resolveGatewayAddress(agent, opts)` and `resolveRuntimeAddress(agent)`
  (`agent-runtime/lib/agentEndpoints.ts`) — **verify, likely no change**. Confirm the host/port path
  Nora uses to reach `18789` / `9090` is unchanged by the policy layer.
- `_buildEndpointResult({ ... })` (`k8s.ts`) — **verify**. Confirm the reachability/readiness it
  reports runs only after the allow-ingress policy exists (so a wrong ipBlock fails fast, per Phase 3
  change #5). Add a readiness check here only if one does not already exist on the path.
- lifecycle methods `status` / `logs` / `exec` / `stop` / `start` / `restart` (`k8s.ts`) — **verify,
  no change**. These go through the Kubernetes API, not the pod app ports, so they must keep working
  after ingress deny. Smoke proves it.

#### Tests

- protected agent remains reachable through the Nora-approved app path
- Kubernetes lifecycle operations still work after policy creation
- another pod in the shared namespace cannot reach the protected pod unexpectedly
- protected NemoClaw pod retains required outbound connectivity
- disallowed outbound connectivity is blocked by at least one enforcement layer

### Phase 5: Extend Backend Contract For Future Admin Visibility

#### Objective

Expose enough structured backend state that the later Admin surfaces can show policy readiness and
effective posture without inventing their own policy model.

#### Files

- `backend-api/kubernetesClusters.ts`
- `agent-runtime/lib/backendCatalog.ts`
- control-plane or admin-facing response builders that surface execution-target details

#### Changes

1. Extend the backend/API response shapes that already describe Kubernetes clusters or execution
   targets so they include policy capability metadata (Phase 1 already persisted these fields; this
   step only ensures they reach the admin/control-plane response builders that don't get them yet):
   - `supportsNetworkPolicy`
   - `policyEngine`
   - target policy status such as `supported`, `degraded`, or `unsupported`

2. Add a deploy/runtime-facing policy status object to the backend contract so later Admin pages do
   not need to infer state from logs. At minimum, the code should expose fields such as:
   - whether baseline policy reconciliation was attempted
   - whether baseline policy reconciliation succeeded
   - whether the runtime is using shared-only policy or shared-plus-NemoClaw-egress policy
   - whether the runtime is blocked or running in degraded policy mode

   This status is computed by the worker at deploy time, so it needs a **persistence location**:
   store it on the agent's DB row (alongside existing per-agent runtime fields like `backend_type`
   and `gateway_token`) so the API returns it without live-querying Kubernetes. Phase 1 covered
   *cluster* capability; this is *per-runtime* status — keep the two distinct (see boundary note
   below) and do not duplicate the cluster fields here.

3. Write the code in the backend layers that assemble these responses:
   - cluster/profile normalization in `backend-api/kubernetesClusters.ts`
   - execution-target issue/status assembly in `agent-runtime/lib/backendCatalog.ts`
   - any admin/control-plane response builder that returns deployment-target details

4. Keep this stage read-only from the API perspective:
   - return structured policy state
   - do not add mutation endpoints yet

#### Functions

Schema: add a `network_policy_status` JSONB column to the `agents` table (`db_schema.sql` +
idempotent `ALTER TABLE` in `server.ts`), to persist the per-runtime status the worker computes.

- the deploy-success persistence in `workers/provisioner/worker.ts` — **change**. Where it already
  writes runtime fields back to the agent row (the UPDATE that sets `sandbox_profile` / `sandbox_type`
  on deploy), include `network_policy_status` from the `policyStatus` returned by `_buildEndpointResult`.
- the agent serializer in `backend-api/routes/agents.ts` (or the shared control-plane response
  builder) — **change**. Surface `networkPolicyStatus` on the agent/deployment response.
- `rowToProfile(row, opts)` and the cluster/execution-target response builders — **verify**. The
  cluster-level `supportsNetworkPolicy` / `policyEngine` were already added in Phase 1; this step only
  ensures any admin/control-plane builder that didn't get them now does. Do not re-add the columns.
- `getExecutionTargetMetadata(...)` (`backendCatalog.ts`) — **change**. Return the derived
  `supported | degraded | unsupported` status so callers don't recompute it.

#### Tests

- execution-target responses include the new capability/status metadata cleanly
- secured/degraded policy state is visible in a stable machine-readable form

### Phase 6: Extend Smoke Coverage

#### Objective

Prove the backend feature works in a real Kubernetes target, not only in unit tests.

#### Files

- `e2e/scripts/k8s-smoke.mts`
- `infra/kind/nora-kind.yaml` (CNI change — see prerequisite below)
- related local-kind / k8s smoke helpers if needed

#### Prerequisite: a policy-enforcing CNI in the smoke cluster

The current Kind config uses the default `kindnet` CNI, which **does not enforce NetworkPolicy** —
policy objects exist but have zero effect on traffic. Every isolation assertion below would falsely
pass. Before writing the assertions, update `infra/kind/nora-kind.yaml` to `disableDefaultCNI: true`
and install a policy-enforcing CNI (Calico is the common choice; Cilium also works) as part of smoke
cluster bring-up. Without this, Phase 6 proves nothing about enforcement.

#### Changes

1. Add smoke assertions, exercised for **both** an OpenClaw and a Hermes deployment (Hermes uses its
   own ports `8642`/`9119` and `app=hermes-agent` selector):
   - expected `NetworkPolicy` objects are created (the per-family ingress pair)
   - the protected pod is isolated from another test pod in the same namespace
   - the Nora-required access path still works on that family's ports
   - Kubernetes lifecycle operations still work through the expected backend path
   - if a Hermes and an OpenClaw agent share a namespace, neither can reach the other's app ports
     (the co-residency case that motivated bringing Hermes in scope)

2. Add NemoClaw-specific smoke coverage for:
   - the NemoClaw pod reaches Ready under egress deny (proves the startup-egress hazard was resolved
     and bootstrap is not blocked)
   - deny-by-default egress at the pod layer
   - DNS allowance (resolution still works with CoreDNS in `kube-system`)
   - required allowed outbound traffic

#### Functions

- `infra/kind/nora-kind.yaml` — **change**. `disableDefaultCNI: true` + install Calico (or Cilium)
  during cluster bring-up (config, not a function).
- In `e2e/scripts/k8s-smoke.mts`, add focused assertion helpers (self-explanatory names):
  `assertNetworkPoliciesExist`, `assertPeerPodBlocked`, `assertRuntimeReachable`,
  `assertNemoReadyUnderEgressDeny`, `assertDnsResolves`, `assertDisallowedEgressBlocked`.
- the smoke bring-up/teardown helper — **change**. Provision the test peer pod used by
  `assertPeerPodBlocked`, and ensure the CNI is ready before deploying agents.

#### Acceptance Criteria

- smoke fails if policies are missing
- smoke fails if peer-pod traffic is still allowed unexpectedly
- smoke fails if Nora loses required runtime access
- smoke fails if the NemoClaw pod cannot reach Ready (bootstrap blocked by egress deny)
- smoke fails if the NemoClaw pod cannot perform its required allowed outbound flows
- (sanity) smoke fails if the cluster CNI does not enforce policy — i.e. the negative isolation
  assertion must actually be able to fail on this cluster

## Future Follow-Up: Admin Read-Only Visibility

This follow-up stage should build on the backend contract from Stage A rather than redefining it.

### Phase 7: Add Admin Deployment / Policy Visibility

#### Objective

Add an Admin-facing surface where operators can inspect Kubernetes deployment state and see whether
baseline network policy is applied and supported.

#### Files

- Admin backend routes / response builders that currently serve deployment details
- the corresponding Admin frontend screens that show Kubernetes execution targets or deployments

#### Changes

1. Add Admin-visible deployment details for Kubernetes-hosted runtimes, including:
   - deployment status
   - runtime family
   - sandbox profile
   - execution target / cluster
   - whether baseline network policy support exists
   - whether the runtime is fully enforced, degraded, or unsupported

2. Surface the shared vs NemoClaw-specific policy mode clearly:
   - shared ingress isolation baseline
   - NemoClaw-specific stricter outbound posture where applicable

3. Keep this stage read-only:
   - visibility only
   - no editing of policy rules yet

#### Functions

First locate the existing admin deployment-detail surface (route handler + frontend screen) — the
plan lists these files generically, so exact names come from that discovery. Expected shape:

- the admin deployment-detail route handler (`backend-api/routes/admin.ts`) — **change**. Include the
  `networkPolicyStatus` (Phase 5) and the cluster's `supportsNetworkPolicy` / `policyEngine` /
  derived status in the response. No new endpoint — extend the existing one.
- a `PolicyStatusBadge` (or similar) presentational component — **new**. Renders
  `supported | degraded | unsupported` consistently; reused by later phases.
- the admin deployment-detail screen component — **change**. Render the new fields, including the
  shared-vs-NemoClaw mode.

#### Tests

- admin response includes policy support and effective posture fields
- UI renders supported / degraded / unsupported states clearly

### Phase 8: Add Admin Lifecycle Context

#### Objective

Integrate the new policy visibility into the existing deployment lifecycle UX without conflating it
with policy editing yet.

#### Files

- Admin frontend deployment detail views
- backend endpoints that already support redeploy/start/stop/restart actions

#### Changes

1. Show the standard deployment controls in the same view where policy state is visible:
   - status
   - redeploy
   - start
   - stop
   - restart, where supported by the existing backend

2. Make it clear when lifecycle actions may be needed to reapply or refresh policy-backed runtime
   state.

3. Keep the UI language explicit about whether an action affects:
   - the runtime workload
   - the policy bundle
   - both

#### Functions

Reuse the existing lifecycle endpoints/actions; this phase is mostly UI wiring.

- the deployment-detail screen component — **change**. Render the existing lifecycle controls
  (status / redeploy / start / stop / restart) in the same view as the `PolicyStatusBadge`, with copy
  clarifying whether an action touches the workload, the policy bundle, or both.
- existing lifecycle action handlers (redeploy/start/stop/restart) — **no change**. They already
  exist; do not fork them. If redeploy is what reapplies/refreshes policy, surface that in the copy,
  not in new backend logic.

#### Tests

- deployment UI still triggers the expected lifecycle actions
- policy-status rendering does not break deployment controls

## Future Follow-Up: Admin Policy Management

This follow-up stage is intentionally later because it depends on the backend contract, enforcement
model, and read-only status surfaces being stable first.

### Phase 9: Add Readable Policy Detail Tabs

#### Objective

Show the effective policy bundle in an Admin-friendly way before introducing editing.

#### Files

- Admin frontend policy/detail tabs
- read-only backend endpoints or expanded responses as needed

#### Changes

1. Add Admin tabs or sections that separate:
   - shared ingress / isolation policy
   - NemoClaw-specific outbound policy posture
   - cluster capability / engine details

2. Show the policy object inventory in readable form rather than raw YAML first.

3. Make it obvious which parts are:
   - shared OpenClaw + NemoClaw behavior
   - NemoClaw-only in v1
   - future/operator-editable areas

#### Functions

- a read-only effective-policy endpoint/response — **new or extended**. Return the policy bundle in a
  structured, readable form (object inventory, not raw YAML). Prefer reading back the deployed
  objects via the worker/adapter over recomputing, so the UI shows what is actually applied. If a new
  adapter read is needed, add `listNetworkPolicies(namespace)` (`k8s.ts`) — **new**.
- `buildPolicySummary(bundle)` (backend) — **new**. Shape the inventory into the three sections
  (shared ingress, NemoClaw outbound, cluster capability/engine) the tabs render.
- the policy-detail tab components — **new**. One section per category; reuse `PolicyStatusBadge`.

#### Tests

- policy detail surfaces render stable read-only summaries
- shared vs NemoClaw-only sections are distinguishable

### Phase 10: Add Admin Outbound Policy Editing

#### Objective

Introduce operator-managed outbound restriction controls in the Admin UI.

#### Files

- Admin backend routes for policy updates
- Admin frontend policy editor surfaces

#### Changes

1. Add the future outbound editing model for:
   - DNS/domain restriction management
   - validation and save/apply behavior
   - effective-policy display

2. Keep the policy editor scoped carefully:
   - do not broaden this into a generic raw-YAML editor in v1 of the UI layer
   - keep user-editable concepts aligned with what the backend can faithfully enforce

3. Define how user-managed outbound rules interact with:
   - the shared baseline policy bundle
   - the existing NemoClaw runtime allowlist model
   - redeploy/restart/apply semantics

#### Functions

This phase finally adds mutation, so it touches both layers.

- a policy-update route handler (`backend-api/routes/admin.ts`) — **new**. Accepts the scoped
  outbound-rule edits, validates them server-side, persists them, and triggers apply/reconcile. Keep
  it scoped — not a generic YAML endpoint.
- `validateOutboundPolicyInput(input)` (backend) — **new**. Reject anything the backend can't
  faithfully enforce; keep editable concepts aligned with the builder layer.
- `buildBaselinePolicyBundle(...)` (`networkPolicies.ts`, from Phase 2) — **change**. Extend to merge
  operator-managed outbound rules into the generated egress objects, so user edits and the baseline
  share one code path.
- `_reconcileNetworkPolicies(...)` (`k8s.ts`, from Phase 3) — **reuse**. Apply path is unchanged; it
  now just reconciles a bundle that includes user rules. Define whether apply is immediate or requires
  redeploy/restart.
- the policy-editor component — **new**. Edit / validate / save / show effective policy.

#### Tests

- policy edits validate cleanly
- saved policy state round-trips correctly
- edited policy state applies without breaking the baseline protection model

## Assumptions Locked In

- shared runtime namespaces remain in place for v1
- policy objects are namespace-local and label-targeted
- one agent runtime remains one Deployment with one pod replica
- Kubernetes `NetworkPolicy` is the pod-level enforcement layer
- NemoClaw/OpenShell remains the runtime-level enforcement layer
- OpenClaw, NemoClaw, and Hermes are all in scope for ingress isolation; the builder layer is
  family-aware (group selector + app ports), the mechanics are shared
- deny-by-default egress is NemoClaw-only in v1; plain OpenClaw and Hermes are ingress-only
- v1 emphasizes inter-pod / ingress isolation plus NemoClaw deny-by-default egress posture
- backend enforcement is implemented before Admin visibility and editing
