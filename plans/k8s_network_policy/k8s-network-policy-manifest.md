# Kubernetes Network Policy Manifest

## Purpose

This document is the source of truth for Nora's Kubernetes network-policy feature direction.
It defines:

- the current Kubernetes runtime shape in Nora,
- the intended relationship between Kubernetes `NetworkPolicy` and NemoClaw/OpenShell policy,
- which parts of the feature are shared across OpenClaw and NemoClaw,
- which parts differ between the two,
- the first-version policy inventory and success criteria.

The goal of the feature is to extend Nora's secured-runtime story to Kubernetes-hosted agents by
adding a Kubernetes-native pod/network control layer on top of the existing runtime policy model.

This manifest remains the source of truth for the **baseline enforcement feature**. Follow-on
operator-editable policy management is intentionally broken out into
`plans/k8s_network_policy/k8s-network-policy-management-plan.md` so the current enforcement
contract and the later editing contract do not get blurred together.

## Problem Statement

Today, Nora can deploy OpenClaw and NemoClaw-flavored runtimes to Kubernetes targets, but the
Kubernetes backend does not yet create `NetworkPolicy` resources. That means shared runtime
namespaces can host multiple Nora-managed agent pods without Kubernetes-native ingress or inter-pod
isolation.

NemoClaw already expresses a deny-by-default outbound policy inside the runtime through
OpenShell-managed `policy.yaml`, but that protection is runtime-local. The cluster network itself
does not yet reflect the same trust posture.

## Current Nora Model

### Kubernetes execution targets

- Nora treats Kubernetes as a deploy target with concrete Admin-registered execution targets such
  as `k8s:aks-eastus2`.
- Cluster registration lives in `backend-api/kubernetesClusters.ts`.
- A cluster profile currently stores:
  - provider
  - kubeconfig / kubeconfig path
  - runtime namespaces
  - exposure mode
- The profile does not yet store network-policy capability or policy-engine metadata.

### Runtime placement

- `workers/provisioner/backends/k8s.ts` creates one Deployment per agent with `replicas: 1`.
- One agent runtime therefore maps to one Deployment and one pod replica in the current backend.
- Pods are deployed into runtime-family namespaces via `_namespaceForRuntimeFamily(...)`.
- Multiple agents can share a runtime namespace such as `openclaw-agents`.
- Hermes is a first-class Kubernetes runtime family alongside OpenClaw. `create(config)` routes
  `runtimeFamily === "hermes"` to `_createHermes(...)`, which uses the same Deployment/Service/
  ConfigMap mechanics. Hermes pods land in `runtimeNamespaces.hermes` (the profile's
  `hermesNamespace`), which **falls back to the OpenClaw namespace when unset** — so Hermes and
  OpenClaw agents can share one namespace. That co-residency is a reason Hermes must be in policy
  scope: if only OpenClaw pods get default-deny ingress, a Hermes pod in the same namespace is an
  unprotected (and untrusted) peer.

### Agent identity inside a shared namespace

Within a shared Kubernetes namespace, Nora differentiates agents by Deployment / Service names and
by stable labels applied to the Deployment and pod template.

Existing labels include:

- `app=openclaw-agent` (OpenClaw family) / `app=hermes-agent` (Hermes family)
- `nora.agent.id`
- `nora.deployment.name`
- `nora.runtime.family` (`openclaw` or `hermes`)
- `nora.execution.target`
- `nora.kubernetes.cluster`
- `openclaw.agent.id` (OpenClaw family only — Hermes pods do not carry this label)

These labels already support lookup, telemetry, and workload selection. This feature will reuse
them for policy targeting. Note the per-family group selector: `app=openclaw-agent` for OpenClaw/
NemoClaw and `app=hermes-agent` for Hermes (`nora.runtime.family` is an equivalent group key for
either).

## Runtime Types And Where They Differ

### Quick comparison

| Area | OpenClaw on Kubernetes | NemoClaw on Kubernetes | Hermes on Kubernetes |
| --- | --- | --- | --- |
| Runtime role | Base Kubernetes runtime path | OpenClaw + stricter sandbox profile | Separate runtime family (`_createHermes`) |
| Namespace model | Shared runtime namespaces | Same shared runtime namespaces | Own `hermes` namespace, may fall back to the OpenClaw one |
| Pod identity / labels | `app=openclaw-agent` + shared Nora labels | Same + `nora.sandbox.profile=nemoclaw` | `app=hermes-agent` + shared Nora labels (no `openclaw.agent.id`) |
| App ports | gateway `18789`, runtime `9090` | Same as OpenClaw | runtime `8642`, dashboard `9119` (no `18789`) |
| Ingress isolation | Yes, shared v1 behavior | Yes, same shared v1 behavior | Yes, same shared v1 behavior (its own ports/selector) |
| Trusted ingress allow rules | Yes, shared v1 behavior | Yes, same shared v1 behavior | Yes, shared v1 behavior on Hermes ports |
| Pod-level deny-by-default egress | Not required by v1 | Yes, NemoClaw-specific v1 behavior | Not required by v1 (like plain OpenClaw) |
| DNS egress allow | Only if later needed by OpenClaw hardening | Yes, required as part of the NemoClaw egress bundle | Not required by v1 |
| Fine-grained outbound allowlist | Not defined as a strict shared contract today | Already exists in OpenShell/NemoClaw runtime policy | Not defined as a strict shared contract today |
| Relationship to OpenShell | None required for baseline OpenClaw path | OpenShell remains the precise runtime outbound enforcement layer | None |

### OpenClaw on Kubernetes

OpenClaw is already supported as the base Kubernetes runtime path.

For this feature, OpenClaw should be treated as:

- the shared Kubernetes policy foundation,
- the base pod identity / namespace / ingress-isolation path,
- the default path for common Kubernetes policy mechanics.

### NemoClaw on Kubernetes

NemoClaw is not a separate runtime family. It is a stricter sandbox profile layered onto the
OpenClaw Kubernetes path.

For this feature, NemoClaw should be treated as:

- inheriting the same shared Kubernetes ingress/isolation framework as OpenClaw,
- adding a stricter outbound policy posture at the pod boundary,
- continuing to rely on OpenShell runtime policy as the precise runtime outbound enforcement layer.

### Hermes on Kubernetes

Hermes is a separate runtime family (not a sandbox profile), already deployable to Kubernetes through
`_createHermes(...)`. Structurally its policy needs are the same as plain OpenClaw — the only
differences are mechanical:

- group selector is `app=hermes-agent` (not `app=openclaw-agent`),
- app ports are runtime `8642` and dashboard `9119` (not gateway `18789` / runtime `9090`),
- it lands in the Hermes namespace, which may be its own or shared with OpenClaw.

For this feature, Hermes should be treated as:

- inheriting the same shared Kubernetes ingress/isolation framework, parameterized by its own group
  selector, ports, and namespace,
- staying ingress-only in v1 (no deny-by-default egress) exactly like plain OpenClaw — Hermes has no
  NemoClaw/OpenShell outbound contract to mirror.

The shared builder layer must therefore be family-aware (selector + ports vary by family), but the
policy mechanics are written once and reused across all three.

### Why they should not be treated as totally separate features

The Kubernetes-side mechanics should not be implemented twice.

Shared concerns such as:

- policy object creation,
- namespace-local policy management,
- label targeting,
- ingress deny-by-default,
- trusted ingress allow rules,
- cluster capability checks

should be written once and reused.

### Why they should not be treated as fully identical either

OpenClaw and NemoClaw do not currently advertise the same outbound security contract.

NemoClaw already has an explicit deny-by-default outbound runtime policy model. Plain OpenClaw does
not currently have the same strong runtime-level contract.

So this feature should:

- share the Kubernetes ingress/isolation framework across both,
- but apply the stricter deny-by-default egress posture first to NemoClaw-selected pods.

### Summary of overlap vs difference

**Shared across OpenClaw, NemoClaw, and Hermes**

- namespace-local `NetworkPolicy` objects
- label-based pod targeting (per-family group selector)
- default deny ingress for Nora-managed agent pods
- trusted ingress allow rules (on each family's app ports)
- agent-to-agent blocking unless explicitly allowed
- cluster capability checks
- deployment-time policy creation and idempotent management

**Different in v1**

- plain OpenClaw stops at shared ingress / isolation behavior
- Hermes also stops at shared ingress / isolation behavior, on its own ports (`8642` / `9119`) and
  group selector (`app=hermes-agent`)
- NemoClaw adds deny-by-default pod egress plus explicit DNS and narrow outbound carve-backs
- NemoClaw continues to rely on OpenShell as the precise runtime outbound policy layer

## Enforcement Model

### Two-layer security model

This feature must treat Kubernetes `NetworkPolicy` and NemoClaw/OpenShell policy as complementary
layers, not interchangeable ones.

- Kubernetes `NetworkPolicy`
  controls pod-level ingress and egress at the cluster network boundary.
- NemoClaw/OpenShell policy
  controls runtime-level behavior inside the container, including outbound endpoint policy plus
  filesystem and capability restrictions.

The intended relationship is:

- same security intent,
- different enforcement layer,
- defense in depth rather than duplication-by-accident.

### Practical interpretation

- Kubernetes policy should answer:
  - who can reach this pod,
  - which pods / namespaces this pod can talk to,
  - which egress flows are permitted at the pod boundary.
- NemoClaw/OpenShell policy should answer:
  - which runtime outbound destinations are permitted,
  - which runtime-side behaviors remain blocked even if pod networking is broader than desired.

### Alignment expectations

The two layers should be aligned in intent but do not need to be a literal 1:1 rule translation.

Why:

- Kubernetes `NetworkPolicy` naturally expresses selectors, namespaces, ports, and CIDRs.
- NemoClaw/OpenShell policy is more runtime- and endpoint-oriented.
- Plain Kubernetes `NetworkPolicy` is not a natural hostname/FQDN policy surface.

So the implementation goal is:

- mirror NemoClaw's deny-by-default posture at the pod layer where practical,
- enforce pod-to-pod and ingress isolation in Kubernetes,
- preserve NemoClaw/OpenShell as the source of truth for precise runtime outbound policy.

## First-Version Scope

### Namespace model

The first version will keep the current shared runtime namespace model.

It will **not** introduce per-agent namespaces.

Instead, v1 will use:

- shared namespaces such as `openclaw-agents`,
- namespace-local `NetworkPolicy` objects,
- label-based isolation for Nora-managed agent pods.

### Policy object model

The feature should not generate one policy object per pod by default.

The primary model should be:

- a small bundle of policy objects per runtime namespace,
- each policy selects groups of Nora-managed pods by label,
- those shared policies automatically apply to newly created matching pods.

This keeps the implementation aligned with Kubernetes policy design and fits Nora's current shared
namespace architecture.

### Policy authoring model

The policy layer should be expressed as a small, Nora-managed bundle of namespace-local policy
objects for each runtime namespace.

These policies should:

- live in the runtime namespace,
- target Nora-managed pods by label,
- apply automatically to newly created matching pods,
- remain stable across redeploys through deterministic names and selectors.

The first version should treat labels as the main grouping primitive for intra-namespace isolation.
It should not rely on pod names as the primary policy key.

### Lifecycle timing

Policy should be created during Nora's Kubernetes deployment flow.

That means the Kubernetes backend should ensure the relevant policy resources exist before or
alongside Deployment / Service creation so new pods come up already covered by the intended rules.

## Delivery Strategy

The full feature should ultimately include both:

- backend enforcement of Kubernetes network policy behavior for Nora-managed runtimes, and
- an Admin-facing Kubernetes deployment / policy management surface.

To keep the work coherent and reduce product/implementation churn, delivery should be staged.

### Stage 1: Backend enforcement foundation

The first stage should focus on backend-first enforcement and source-of-truth modeling.

This stage should deliver:

- cluster capability modeling for `NetworkPolicy` support,
- namespace-local policy creation during Kubernetes deployment,
- shared ingress isolation for OpenClaw and NemoClaw pods,
- NemoClaw-specific deny-by-default pod egress posture,
- smoke and validation coverage,
- enough backend metadata for later admin visibility.

Why this stage comes first:

- the admin UI needs real backend state and policy objects to display,
- the highest-risk part of the feature is the enforcement layer,
- the UI should not invent policy semantics before the backend contract exists.

This Stage 1 backend foundation is the committed implementation scope for the current feature.
The later Admin stages below are planned follow-up work that should build on Stage 1 rather than
expand its immediate implementation scope.

### Stage 2: Admin read-only visibility

The second stage should add Admin-facing visibility into the deployed policy state.

This stage should focus on:

- Kubernetes deployment details in the Admin panel,
- deployment lifecycle visibility such as status / restart / stop / redeploy context where
  appropriate,
- read-only visibility into applied network policy state,
- clear display of whether the target is fully enforced, partially enforced, or degraded.

This stage should not require fully editable policy management yet.

### Stage 3: Admin policy management

The third stage should add operator-managed policy editing and control surfaces.

This stage can include:

- Admin tabs for network policy inspection and editing,
- outbound destination management such as DNS/domain restrictions,
- validation, save/apply, and effective-policy display,
- policy update / redeploy semantics.

This stage should build on the stable backend enforcement model rather than defining the policy
contract from the UI outward.

## Shared Kubernetes Policy Behavior

The following behavior should be shared across Kubernetes-hosted OpenClaw and NemoClaw runtimes.

### Shared ingress isolation

V1 should use deny-by-default ingress for Nora-managed agent pods in the runtime namespace.

The intent is:

- agent pods should not accept arbitrary traffic from other workloads in the shared namespace,
- agent-to-agent communication should be blocked unless explicitly allowed,
- only Nora-approved sources should be able to reach gateway/runtime ports.

This is the main Kubernetes-native inter-pod protection goal and should not be NemoClaw-only.

### Shared ingress rule shape

Ingress policies use a label `podSelector` for the protected destination and an `ipBlock` for the
trusted source:

- `podSelector` for the Nora-managed agent pods being protected (the group label, not a per-agent
  label),
- `ipBlock` CIDR for the trusted source that is allowed in,
- explicit TCP ports for gateway/runtime access.

Why this is the right split:

- `podSelector` identifies the destination pods the policy applies to. It must be the group label
  (`app=openclaw-agent`), because the protected workloads are not "all pods in the namespace"; they
  are the Nora-managed agent pods identified by label.
- the trusted source is the **external** Nora control plane, which arrives SNAT'd to a node/LB
  address. `namespaceSelector`/`podSelector` only match in-cluster sources, so they cannot express
  this source — an `ipBlock` is required (see Resolved Decisions for the per-exposure-mode CIDR).

So the expected v1 pattern is:

- use `podSelector` to select the Nora agent pods in the runtime namespace,
- use an `ipBlock` source to express which external caller is allowed to reach those pods.

The initial trust model should assume:

- random peer pods in the shared runtime namespace are not trusted,
- agent-to-agent traffic is blocked unless explicitly allowed,
- only Nora-approved sources should be able to reach agent gateway/runtime ports.

### Shared ingress ports and access paths

For OpenClaw-family runtimes, the app-level surfaces Nora needs to reach are:

- gateway: `TCP 18789`
- runtime: `TCP 9090`

For Hermes runtimes, the app-level surfaces are different:

- runtime / API server: `TCP 8642`
- dashboard: `TCP 9119`

These are the ports the Kubernetes backend exposes through each family's service and pod template.
The trusted-ingress allow policy reopens the appropriate set for the family being deployed; the
default-deny baseline is otherwise identical.

Important distinction:

- Kubernetes lifecycle operations such as start/stop/restart/status/logs/exec are handled through
  the Kubernetes API / backend adapter path and do **not** require broad app-port ingress to the
  pod.
- Runtime HTTP access, gateway proxying, NemoClaw status/policy/approvals, and integration/runtime
  sync flows **do** require reachability to the OpenClaw gateway/runtime surfaces.

So the ingress allow policy should be thought of as:

- reopening only the required OpenClaw application ports after default deny ingress,
- not broadly reopening access for generic Kubernetes control-plane operations.

The remaining design variable is the source model for those allowed connections across the supported
Kubernetes exposure modes:

- `cluster-ip`
- `node-port`
- `load-balancer`

### Shared policy object mechanics

OpenClaw, NemoClaw, and Hermes should all reuse the same:

- namespace-local object model,
- label-targeting model (parameterized by each family's group selector),
- deterministic policy naming approach,
- deployment-time policy creation path,
- cluster capability checks for standard `NetworkPolicy` support.

The only family-specific inputs are the group selector and the app ports; the mechanics above are
written once.

## OpenClaw-Specific Policy Behavior

### OpenClaw-specific role in v1

Plain OpenClaw should receive the shared Kubernetes ingress/isolation framework described above.

That means OpenClaw should get:

- default deny ingress,
- trusted-ingress allow rules,
- shared namespace / label-based isolation,
- the same namespace-local policy framework used by NemoClaw.

### OpenClaw-specific outbound posture

V1 should **not** assume that plain OpenClaw automatically inherits the full NemoClaw
deny-by-default outbound stance.

Reason:

- the current Nora product/runtime model already treats NemoClaw as the stricter sandbox profile,
- applying the same outbound deny-by-default posture to all OpenClaw Kubernetes runtimes would be a
  broader product/security change than "bring NemoClaw policy parity to Kubernetes."

So in v1:

- OpenClaw gets the shared ingress and inter-pod protections,
- OpenClaw does not automatically get the full NemoClaw-specific strict egress bundle unless that
  is chosen as an explicit future hardening step.

### OpenClaw and outbound policy in v1

The manifest should assume that OpenClaw's outbound behavior remains less opinionated than
NemoClaw's in the first implementation pass.

This means:

- OpenClaw still benefits from shared ingress isolation and blocked peer-pod access,
- OpenClaw does not yet get the same deny-by-default outbound bundle as NemoClaw,
- broader outbound hardening for OpenClaw can be a later, explicit product decision rather than an
  accidental side effect of the NemoClaw parity work.

## NemoClaw-Specific Policy Behavior

### NemoClaw-specific role in v1

NemoClaw should inherit all shared Kubernetes ingress/isolation behavior and add a stricter
outbound posture at the pod boundary.

### NemoClaw-specific egress posture

For NemoClaw-selected pods, v1 should use deny-by-default egress at the Kubernetes layer and then
allow only the traffic Nora expects to support.

This does **not** mean NemoClaw pods should lose outbound connectivity. It means:

1. Kubernetes egress starts from deny,
2. Nora explicitly allows minimal required egress,
3. NemoClaw/OpenShell continues enforcing its runtime-level outbound policy too.

This mirrors the current NemoClaw security posture more closely than allow-all egress would.

In practical terms, the Kubernetes-side default deny is mainly there to ensure:

- peer pods in the namespace are not reachable by default,
- unexpected cluster-internal egress is blocked by default,
- external outbound access starts from deny rather than allow-all.

The exact external outbound destination policy should still be treated as primarily a
NemoClaw/OpenShell concern in v1, because that runtime policy layer already models the intended
allowlist more precisely than plain Kubernetes `NetworkPolicy` can.

### NemoClaw-specific egress rule shape

Egress policy should be split into two categories:

1. **selector-based pod/network egress**
   for pod-to-pod or namespace-to-namespace communication inside the cluster
2. **coarse external egress**
   for DNS and any external traffic the standard Kubernetes `NetworkPolicy` API can reasonably
   constrain

For v1:

- selector-based rules should be the primary way to block or allow pod-to-pod communication,
- DNS should be explicitly allowed for NemoClaw-selected pods,
- external internet egress should remain intentionally narrow,
- Kubernetes policy should provide coarse pod-boundary restriction,
- NemoClaw/OpenShell should remain the precise runtime-level outbound allowlist.

### NemoClaw and internet egress

Internet egress is still allowed where required for NemoClaw, but it should remain intentionally
narrow.

The Kubernetes layer should not be expected to perfectly encode the same hostname semantics as the
runtime policy.

Instead:

- Kubernetes policy narrows the pod's outbound posture,
- NemoClaw/OpenShell policy remains responsible for the finer-grained endpoint allowlist.

Later follow-up work may expose operator-configurable outbound destination rules in the Admin UI.
That future feature should be understood as an extension of the outbound allowlist story, not as a
reason to avoid deny-by-default egress in the base Kubernetes policy model.

This is especially important for external internet destinations, because standard Kubernetes
`NetworkPolicy` is more naturally selector / CIDR oriented than hostname oriented.

## Policy Object Inventory

The first implementation should be organized around a small, explicit policy bundle per runtime
namespace.

### Shared objects for OpenClaw, NemoClaw, and Hermes

These ingress objects are emitted per runtime family, targeting that family's group selector in its
namespace. The OpenClaw/NemoClaw variant targets `app=openclaw-agent`; the Hermes variant targets
`app=hermes-agent` and reopens the Hermes ports instead of the OpenClaw ones.

#### 1. Default deny ingress for Nora-managed agent pods

Purpose:

- make Nora-managed agent pods ingress-isolated by default,
- block arbitrary pod-to-pod communication in the shared namespace,
- require explicit allow policies for gateway/runtime reachability.

Targets:

- pods labeled as Nora-managed agent workloads in the runtime namespace — `app=openclaw-agent` for
  the OpenClaw/NemoClaw bundle, `app=hermes-agent` for the Hermes bundle.

#### 2. Allow trusted Nora ingress to gateway/runtime ports

Purpose:

- restore the minimum Nora-required access path after default deny ingress,
- allow only trusted sources to reach gateway/runtime ports,
- keep agent pods unreachable from untrusted peer pods.

What "restore Nora-required access" means here:

- open only the specific TCP ports Nora actually uses to reach the agent gateway/runtime surfaces,
- allow those ports only from trusted sources,
- do not broadly reopen ingress to the whole namespace or to arbitrary pods.

This is about reopening the required app ports after default deny ingress. It is not about allowing
arbitrary DNS ingress or giving the entire cluster blanket access to the pod.

For OpenClaw-family runtimes in v1, this should be understood concretely as reopening:

- `TCP 18789` for gateway access
- `TCP 9090` for runtime access

For Hermes runtimes, the equivalent reopened ports are:

- `TCP 8642` for runtime / API-server access
- `TCP 9119` for dashboard access

The exact source-matching strategy still depends on the cluster exposure mode and how Nora reaches
those services in practice.

Targets:

- same Nora-managed agent pod set as the deny-ingress policy.

Allowed peers:

- an `ipBlock` CIDR allowlist for the external Nora control plane, resolved per exposure mode (see
  Resolved Decisions). Not `namespaceSelector`/`podSelector`, since the trusted source is external to
  the cluster.

### NemoClaw-only objects in v1

#### 3. Default deny egress for NemoClaw-selected pods

Purpose:

- mirror NemoClaw's deny-by-default outbound posture at the pod boundary,
- block pod-to-pod and general outbound traffic unless explicitly allowed.

Targets:

- Nora-managed agent pods with the NemoClaw sandbox label/profile.

#### 4. Allow DNS egress for NemoClaw-selected pods

Purpose:

- preserve required name resolution after deny-by-default egress,
- keep the DNS allowance narrow and explicit.

Targets:

- same NemoClaw-selected pod set as the deny-egress policy.

#### 5. Allow required internal or control-plane egress if needed

Purpose:

- permit only the minimal cluster-internal egress flows Nora proves are required,
- keep selector-based pod/network egress explicit instead of implicit.

Targets:

- same NemoClaw-selected pod set, or a narrower subset if implementation requires it.

Conceptually, this bucket is for cluster-internal communication the runtime may truly need beyond
plain DNS and external internet access.

Examples could include:

- a required in-cluster service dependency,
- an approved Nora-managed helper workload,
- another explicitly trusted internal endpoint.

What this section does **not** mean:

- it does not assume the managed Kubernetes control plane itself needs to reach the agent's
  gateway/runtime application ports,
- it does not mean AKS/EKS/GKE must be granted blanket app-level pod access,
- it does not imply Nora should broadly allow cluster-internal traffic "just in case."

The Kubernetes control plane manages workloads through the cluster control plane and node plumbing;
that is separate from the app-level ingress path Nora uses to reach the runtime over its exposed
service/gateway ports. So this policy object should only exist for real, proven in-cluster egress
dependencies.

#### 6. Allow coarse external egress categories where standard NetworkPolicy can help

Purpose:

- add pod-boundary guardrails for external egress where the cluster can express them reasonably,
- complement rather than replace NemoClaw/OpenShell endpoint policy.

Targets:

- same NemoClaw-selected pod set.

## Cluster Capability Model

The feature requires Nora to understand whether an execution target can actually enforce standard
Kubernetes `NetworkPolicy`.

The cluster profile should be extended with capability metadata such as:

- `supportsNetworkPolicy`
- `policyEngine`

Initial implementation only needs enough metadata to determine whether the cluster supports the
standard Kubernetes `NetworkPolicy` API semantics required for v1.

Engine-specific features are not part of MVP.

## Non-Goals For V1

V1 should not attempt to:

- support every policy-engine-specific feature,
- translate the full NemoClaw endpoint allowlist exactly into engine-specific FQDN policy,
- redesign Nora around per-agent namespaces,
- replace NemoClaw/OpenShell runtime policy with Kubernetes policy,
- automatically impose the full NemoClaw outbound posture on all plain OpenClaw runtimes,
- impose deny-by-default egress on Hermes runtimes (Hermes is ingress-only in v1, like plain OpenClaw),
- add a broad operator-facing network-policy editor in the UI.

## Success Criteria

The feature is successful when:

1. Nora can identify whether a Kubernetes execution target supports baseline network-policy
   enforcement.
2. Nora-managed agent pods in shared runtime namespaces are denied ingress by default unless
   explicitly allowed.
3. Shared-namespace agent-to-agent communication is blocked unless explicitly allowed.
4. OpenClaw, NemoClaw, and Hermes all inherit the shared ingress/isolation framework (each on its own
   group selector and app ports).
5. NemoClaw-selected k8s pods use deny-by-default egress at the Kubernetes layer plus their
   existing runtime-level deny-by-default policy.
6. Required Nora control-plane access still works after policy creation, for all three families.
7. Smoke coverage proves the expected Kubernetes policy objects exist and actually affect traffic.

## Resolved Decisions (v1)

These were previously open; they are now locked for v1. See the implementation plan's
"Locked decisions" section for the detailed rationale.

1. **Trusted ingress sources for gateway `18789` / runtime `9090`:** use an `ipBlock` CIDR allowlist
   resolved per exposure mode (node CIDR for `node-port`, `loadBalancerSourceRanges` for
   `load-balancer`, node/kubelet IP for `cluster-ip`). Nora's control plane is external to the
   cluster, so in-cluster `namespaceSelector`/`podSelector` cannot express the trusted source. The
   default-deny ingress policy still blocks all pod-to-pod ingress on every port; the allow policy
   only reopens the two app ports from that ipBlock.
2. **Plain OpenClaw egress:** ingress-only in v1, no egress policy. Pod-to-pod is already denied
   bidirectionally by default-deny ingress. Stricter deny-by-default OpenClaw egress remains a later,
   explicit hardening decision.
3. **Unsupported targets:** do not hard-fail. Allow the deploy, skip k8s policy creation, mark it
   `degraded`, and rely on the NemoClaw/OpenShell runtime layer for outbound control.

Additionally, cluster capability (`supportsNetworkPolicy` / `policyEngine`) is **auto-probed** at
registration (best-effort: API availability plus CNI/engine detection) and operator-overridable,
rather than purely operator-declared.
