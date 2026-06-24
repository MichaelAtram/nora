# Kubernetes Network Policy Management Plan

## Purpose

This document covers the **editable ingress** layer that sits on top of Nora's baseline Kubernetes
`NetworkPolicy` enforcement. The baseline itself is specified elsewhere:

- `plans/k8s_network_policy/k8s-network-policy-manifest.md`
- `plans/k8s_network_policy/k8s-network-policy-implementation-plan.md`

The detailed execution sequence for this management follow-on lives in:

- `plans/k8s_network_policy/k8s-network-policy-management-implementation-plan.md`

Those documents define the Nora-owned baseline behavior we treat as fixed here:

- default-deny ingress for Nora-managed agent pods
- trusted-ingress allow rules for OpenClaw and Hermes
- capability detection and per-agent `networkPolicyStatus`

This document should be read as **part 2 of the same network-policy feature line**. Part 1 already
established the Nora-owned baseline on the network-policy branch; this follow-on does not redesign
or re-implement that baseline. It only adds operator-managed ingress on top of it.

This document is now intentionally **ingress-only for active development**. Earlier egress planning
has been preserved in a deferred appendix at the bottom so it can be revisited later, but that
appendix **must not be used when implementing the current feature**.

## Feature Summary

The editable management feature has three defining properties:

- **target-scoped** — configuration attaches to a Kubernetes execution target, not an agent
- **ingress-only for v1** — custom ingress is the active editable surface
- **additive to Nora's baseline** — operators extend the baseline, they never replace it

Concretely, the responsibility split is:

- Nora continues to own the default-deny ingress wall.
- Nora continues to own the minimum trusted ingress the runtime needs to function.
- Operators may add allow rules for additional trusted ingress sources.

This keeps the feature pointed at the main security goal of the current work:

- deny pod-to-pod communication by default
- reopen only the ingress paths Nora or the operator explicitly trusts

## What This Feature Is And Is Not

The boundary below is explicit so reviewers can quickly tell what this plan commits to and what it
deliberately defers.

### In scope

- continuing from the already-developed part 1 baseline on the same feature branch
- operator-authored **ingress allow rules** for Kubernetes-backed OpenClaw and Hermes targets
- backend storage for those rules on the execution target
- reconciliation of additive ingress `NetworkPolicy` objects
- read/write Admin APIs for policy settings
- apply-status reporting for live targets
- a backend contract shaped so a later Admin cluster detail panel can manage these rules cleanly

### Out of scope

These are nearby ideas excluded on purpose to keep the feature bounded:

- reworking or re-specifying the Nora-owned baseline from part 1
- free-form raw YAML editing
- per-agent bespoke policy authoring
- replacing or disabling Nora's baseline policy bundle
- editable Kubernetes egress management for this feature
- domain/DNS blocking inside the Kubernetes `NetworkPolicy` feature
- engine-specific CRDs such as `CiliumNetworkPolicy`

The previously drafted egress material is preserved in the appendix:

- [Deferred Appendix: Future Egress Exploration](#deferred-appendix-future-egress-exploration-do-not-use-for-current-feature-development)

## Why The Scope Is Ingress-Only

Standard Kubernetes `NetworkPolicy` is strongest at:

- pod-to-pod isolation
- namespace-to-namespace traffic control
- CIDR-based ingress control
- port-based ingress control

That set maps cleanly onto Nora's requirement, because the main question we need to answer is:

- **who can reach Nora-managed agent pods?**

That is fundamentally an ingress problem. Pod-to-pod communication has two sides — egress from the
source and ingress to the destination — but default-deny ingress on the destination is the simpler
and more decisive control. If pod B denies ingress by default, pod A cannot reach it regardless of
what pod A's egress rules permit.

## Product Model

Nora-owned baseline policy and operator-authored ingress policy combine into a single effective
ingress posture on each target. The three subsections below define each piece.

### Baseline Nora-owned policy

Nora always owns:

- default-deny ingress
- trusted-ingress allow rules derived from target configuration
- runtime-family-specific required ports

Operators do not replace any of these through this management feature.
This baseline is considered **already developed by part 1** and is treated as a prerequisite,
not active scope for this follow-on.

### Operator-authored policy

On top of the baseline, an operator may add:

- extra ingress allow rules for OpenClaw
- extra ingress allow rules for Hermes

These are **additive only**. The operator does not edit the baseline deny rule, and does not
redefine how Nora derives its own trusted ingress from exposure mode and source ranges.

### Effective policy

The live effective policy on a target is therefore:

- the Nora baseline ingress bundle
- plus operator-authored additive ingress rules

This baseline-vs-operator split must stay visible in both the backend and the future UI.

## Policy Scope

Editable policy is **execution-target scoped**. A single Kubernetes execution target can define:

- custom OpenClaw ingress rules
- custom Hermes ingress rules

Target scope is the right unit because:

- the existing policy bundle is already namespace-local and target-oriented
- the future UI is described as an Admin deployment/target surface
- it is simpler than per-agent overrides

Per-agent ingress rules are out of scope for v1.

## Data Model

Editable policy settings are stored as a structured column on `kubernetes_clusters`:

- `policy_settings jsonb not null default '{}'::jsonb`

The **active** settings payload for this feature is ingress-only:

```json
{
  "ingressRules": {
    "openclaw": [
      {
        "id": "uuid",
        "cidr": "203.0.113.10/32",
        "ports": [18789, 9090],
        "description": "corp vpn"
      }
    ],
    "hermes": [
      {
        "id": "uuid",
        "cidr": "198.51.100.0/24",
        "ports": [8642, 9119],
        "description": "trusted ui users"
      }
    ]
  }
}
```

Structured JSON is preferred over raw YAML because it gives us:

- straightforward validation
- straightforward frontend forms
- straightforward reconciliation/diffing
- a cleaner migration path later

Rule `id` is part of the stored payload so the future UI can preserve stable row identity while
editing, but it is **not** part of live Kubernetes object identity. Reconciliation and dedupe are
based on the normalized rule content, not on the rule `id`.

## Validation Rules

These rules define the backend contract for accepting, normalizing, rejecting, and deduplicating
custom ingress rules. They keep the editable surface aligned with the current runtime exposure model
rather than opening an unrestricted port-authoring feature.

### Ingress rules

Each ingress rule must validate:

- `cidr` is a valid IPv4 or IPv6 CIDR
- `ports` is a non-empty list of valid TCP ports
- the runtime family is one of `openclaw` or `hermes`
- `description` is optional and length-bounded

Normalization, applied before comparison/storage:

- trim surrounding whitespace from `cidr` and `description`
- normalize CIDR strings to canonical form
- sort `ports` ascending and remove duplicates within the rule
- treat an omitted `description` as `null`
- preserve `id` if supplied; generate one if a stored rule is missing it

Reject a rule when:

- `cidr` is missing, malformed, or not a CIDR
- `ports` is missing, empty, or contains a non-numeric port
- any port is outside `1-65535`
- the runtime family bucket is not `openclaw` or `hermes`
- the normalized port set contains a port outside the family baseline

Family baseline ports — ingress rules may only target the runtime's own ports:

- OpenClaw: `18789` and `9090`
- Hermes: `8642` and `9119`

Additional rule-shape clarifications:

- a rule may target either one baseline port or both baseline ports for its runtime family
- IPv4 and IPv6 rules may coexist in the same family list
- overlapping CIDRs are allowed; the API does not try to collapse or reject them
- the feature does not attempt semantic analysis such as "broader CIDR already covers narrower
  CIDR"; it only validates syntax and dedupes exact normalized matches

Dedupe — two ingress rules are duplicates when they resolve to the same normalized tuple:

- runtime family
- canonical CIDR
- sorted unique port set

`description` does not make two otherwise identical rules distinct. Exact duplicates within one
payload collapse to a single stored rule. If the API instead rejects duplicates rather than
collapsing them, it must return a clear duplicate-rule error. Pick one behavior and apply it
consistently.

## API Surface

The backend exposes explicit target-level endpoints before any frontend work begins, so the future
Admin UI builds against a stable contract. Both endpoints are target-level rather than agent-level
because the policy model is already target/namespace oriented.

### Read endpoint

```
GET /admin/kubernetes-clusters/:id/policy-settings
```

Returns:

- stored operator-authored ingress settings
- a summary of the Nora baseline policy
- capability/support status
- last apply status and any issue/warning emitted by reconciliation
- the desired-state hash / revision metadata the UI can use to understand whether the latest saved
  state is the same one the worker last processed

### Write endpoint

```
PUT /admin/kubernetes-clusters/:id/policy-settings
```

Behavior:

- treats the submitted payload as a **full replacement** for the target's operator-managed ingress
  settings
- omitted family lists are treated as empty lists
- validate the submitted structured payload
- persist it
- trigger reconciliation for the affected targets/namespaces
- return the updated apply status

Write-time cluster behavior is intentionally simple:

- reject only structural problems such as invalid payloads or unknown clusters
- do **not** reject writes merely because the target is currently disconnected or because
  `supportsNetworkPolicy` is currently false
- persist desired state first, then let reconciliation surface whether the target could actually
  apply it

That keeps the API in desired-state mode rather than coupling saves to current cluster reachability.

## Reconciliation Model

This section defines how stored ingress settings become live Kubernetes `NetworkPolicy` objects on
the target cluster.

### Baseline behavior

Baseline reconciliation is unchanged:

- Nora creates the default-deny ingress policy
- Nora creates the trusted-ingress allow policy

### Custom ingress behavior

Operator ingress rules are reconciled into a **separate additive ingress policy object per runtime
family**, distinct from the baseline allow policy:

- `nora-openclaw-operator-allow-ingress`
- `nora-hermes-operator-allow-ingress`

Keeping these in their own objects (rather than mutating the baseline allow policy) means:

- baseline and operator intent stay separable
- reconciliation is easier to reason about
- the UI can clearly distinguish Nora-owned rules from operator-owned rules

### Apply strategy

Edits follow the repo's standard control-plane → BullMQ → worker → adapter path: `PUT` validates and
persists `policy_settings` (desired state) and enqueues a reconciliation job; the worker applies
the operator objects via the adapter's existing create-or-replace upsert (`_upsertNetworkPolicy`).

Two consequences are worth calling out:

- **Edits are queued, not inline.** backend-api has no cluster client in the write path. A save is
  `persisted + queued`; live state is only confirmed once the worker reports back.
- **Edits are latest-write-wins.** The queue coalesces work per cluster target. A worker run must
  load the latest stored `policy_settings` from the database rather than trusting stale job
  payloads, so repeated saves collapse naturally toward the newest desired state.
- **Reconciliation must prune, not just upsert.** The current baseline loop
  (`_reconcileNetworkPolicies`) only upserts. For operator ingress objects that is insufficient:
  removing the last rule of a family must delete its live object. Reconciliation computes the
  desired set from `policy_settings` and, per family, upserts when rules exist or
  `deleteNamespacedNetworkPolicy` when the rule list is empty — confined to
  `nora-*-operator-allow-ingress` names so baseline objects are never touched.

Namespace changes require one more cleanup rule. If the execution target's OpenClaw or Hermes
namespace changes, reconciliation must delete the old operator-managed policy object from the last
applied namespace before marking the new desired state as applied. The status payload therefore
needs to remember the last namespace(s) where operator objects were successfully applied.

The control plane then reports **queued** / **applying** / **applied** / **failed**, plus
`customPolicyIssue`, so the UI never shows a merely-persisted rule as live.

## Status Model

The status surface must let the UI separate baseline policy state from custom ingress policy state.

The existing `networkPolicyStatus` shape remains the base runtime status:

- `policyStatus`
- `policyBundleAttempted`
- `policyBundleApplied`
- `policyIssue`

This feature adds target-level reporting for:

- `customPolicyConfigured`
- `customPolicyApplied`
- `customPolicyIssue`
- `customIngressConfigured`

The target-level status payload should also carry enough metadata to tie status to one concrete
saved rule set, for example:

- `state`
- `desiredHash`
- `appliedHash`
- `lastAppliedNamespaces`
- `customPolicyAppliedAt`

State semantics are:

- `queued` — the latest desired state was persisted and a reconcile job was enqueued, but no worker
  attempt has started yet for that desired hash
- `applying` — a worker has started reconciling that desired hash
- `applied` — the worker successfully reconciled that desired hash **and** verified the expected
  operator policy objects/prune results with Kubernetes read-back
- `failed` — the worker attempted that desired hash and could not verify the expected live result

`applied` and `failed` always describe the same `desiredHash` the worker most recently processed.
If the user saves a newer rule set, backend-api should immediately move status back to `queued`
under the new desired hash rather than leaving the old result visible as if it still described the
latest desired state.

`customPolicyWarnings` may still exist as a generic status channel, but the active ingress-only
scope does not depend on the selector-based warning flow that the deferred egress appendix explored.

## Frontend Follow-On Contract

Frontend implementation is a follow-on slice, but the intended surface should be planned now so the
backend contract does not drift away from the UI that will consume it.

The intended Admin information architecture is:

### `/kubernetes` registry page

This page should continue to be the main Kubernetes entry point in the admin dashboard. It should
show **registered clusters** in a list/overview format, similar in spirit to other Nora registry
pages.

This page should contain:

- the existing **Add cluster** button in the same general header area
- a list of registered clusters
- status/context fields that make it easy to scan the registry, such as:
  - label
  - provider
  - exposure mode
  - enabled/disabled
  - connection / test status

Clicking a cluster should navigate to a dedicated detail page rather than expanding the entire edit
form inline on the registry page.

### `/kubernetes/[id]` detail page

This page should follow the same broad visual language as Nora detail pages such as fleet detail:

- a read-only overview header
- status badges / summary cards
- tabbed detail sections beneath the summary

The detail page should contain three primary tabs:

- `Overview`
- `Cluster Config`
- `Network Policy`

### `Overview` tab

This tab is read-only. It should summarize the cluster and policy state at a glance, for example:

- provider / cluster name
- namespace layout
- exposure mode
- enabled / connected / last test status
- baseline NetworkPolicy support state
- custom ingress apply state

### `Cluster Config` tab

This tab should host the **existing cluster edit form** that currently lives on the one-page
Kubernetes admin surface. The goal is not to invent a new config model, only to place the current
editing experience inside a clearer detail-page layout.

This tab should therefore preserve the existing configuration controls, including:

- cluster identity fields
- kubeconfig / credential settings
- namespace fields
- exposure mode and network exposure settings
- test / enable / disable actions

### `Network Policy` tab

This tab should be the home for the editable ingress feature described in this document.

For v1 it should show:

- baseline policy status summary
- operator-managed ingress rules
- OpenClaw and Hermes ingress sections as applicable to the target/runtime support model
- save/apply status for the latest desired rule set

It should **not** include egress UI in this version.

The network policy tab should be able to:

- list the currently saved operator-authored rules
- add, edit, and remove rules locally in the form
- save via full-replacement `PUT /admin/kubernetes-clusters/:id/policy-settings`
- show whether the latest save is queued, applying, applied, or failed

This planning section does **not** require frontend implementation in the backend-first slice, but
it does require the backend response shape to be friendly to that eventual page split and tabbed
detail panel.

## Implementation Follow-On

The detailed, function-level execution sequence now lives in
`plans/k8s_network_policy/k8s-network-policy-management-implementation-plan.md`.

At a high level, that implementation plan breaks the active work into three parts:

1. store and validate target-level ingress `policy_settings`
2. reconcile operator ingress objects
3. persist apply status for the Admin surface

## Recommended Next Step

Start with **Phases 1 and 2** from the dedicated implementation plan. That gives the frontend a
stable backend contract for the part of the feature that is already well defined:

- target-scoped ingress settings
- validation
- read/write APIs
- clear apply status

Starting here keeps the editable policy work aligned with the purpose of the current network policy
feature rather than expanding it into a broader outbound-control project.

## Deferred Appendix: Future Egress Exploration (Do Not Use For Current Feature Development)

This appendix preserves earlier egress planning so it can be revisited later. It is **not approved
scope** for the current feature and **must not be used when developing the current implementation**.

### Preserved Egress Shape

The earlier draft assumed the Nora-owned egress baseline would remain unchanged:

- OpenClaw: no extra k8s egress bundle in baseline v1
- Hermes: no extra k8s egress bundle in baseline v1
- NemoClaw: Nora-owned deny-by-default pod egress bundle, already defined by the baseline feature

On top of that baseline, the draft explored **optional operator-authored egress rules** for
OpenClaw and Hermes, expressed in standard Kubernetes `NetworkPolicy` terms:

- CIDR-based destinations
- namespace / pod selectors
- port-based restrictions

That exploration remains deferred because standard Kubernetes egress is allowlist-oriented and was
not a strong fit for the current agent-management scope.

### Preserved Future Data Model Extension

The earlier draft also assumed the payload might later grow to:

```json
{
  "ingressRules": {
    "openclaw": [],
    "hermes": []
  },
  "egressRules": {
    "openclaw": [
      {
        "id": "uuid",
        "action": "deny",
        "cidr": "10.0.0.0/8",
        "ports": [443],
        "description": "block private range"
      }
    ],
    "hermes": []
  }
}
```

This shape is preserved only as a historical draft. It is not part of the active implementation
contract.

### Preserved Future Egress Validation Notes

The earlier draft expected future egress rules to validate:

- `action` from a small enum such as `allow` or `deny`
- exactly one destination shape:
  - `cidr`
  - `namespaceSelector`
  - `podSelector`
  - `namespaceSelector + podSelector`
- optional ports
- optional description

It also expected selector validation to split into:

1. a deterministic format check at submit time
2. a live-cluster match check that surfaces zero-match selectors as warnings

Those ideas are preserved here for future product review only.

### Preserved Future Egress Reconciliation Notes

The earlier draft expected future operator egress rules to reconcile into separate additive objects:

- `nora-openclaw-operator-egress`
- `nora-hermes-operator-egress`

It also expected the control plane to report:

- `customEgressConfigured`
- selector-based `customPolicyWarnings`

That future work remains deferred and is intentionally excluded from the current feature build.
