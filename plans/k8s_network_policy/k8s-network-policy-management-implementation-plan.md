# Kubernetes Network Policy Management Implementation Plan

## Purpose

This document translates `plans/k8s_network_policy/k8s-network-policy-management-plan.md` into an
engineer-facing execution sequence. It is meant to be detailed enough that an engineer new to this
codepath can use it as a working skeleton for the backend portion of the feature.

This plan covers the **editable ingress management follow-on**, not the already-built baseline
policy enforcement. The baseline implementation lives in:

- `plans/k8s_network_policy/k8s-network-policy-manifest.md`
- `plans/k8s_network_policy/k8s-network-policy-implementation-plan.md`

The active management follow-on has two goals:

1. Add target-scoped storage and APIs for operator-authored ingress policy settings.
2. Reconcile those settings into additive Kubernetes ingress `NetworkPolicy` objects without
   mutating Nora's baseline policy bundle.

This plan assumes we are continuing on the **same network-policy branch lineage as part 1**.
Part 1 already built the Nora-owned baseline enforcement path; this document does not ask the
reader to rebuild that baseline, only to extend it with operator-managed ingress.

Earlier egress implementation ideas are preserved in a deferred appendix at the bottom of this
document. That appendix **must not be used when developing the current feature**.

## Locked Scope For This Plan

The phases below assume the following active scope from the management plan:

- the Nora-owned baseline from part 1 already exists and is treated as prerequisite code
- policy settings are **execution-target scoped**
- ingress is the only editable surface in this feature
- operator-authored objects are **additive** and must stay separate from Nora-owned baseline
  objects
- policy writes are **queued for reconciliation**, not applied inline in the admin request path
- editable Kubernetes egress is deferred and preserved only in the appendix
- DNS/domain blocking is **not** part of this feature

## Existing Code To Reuse

### Cluster profile / Admin settings path

- `backend-api/kubernetesClusters.ts`
  Owns cluster-profile normalization, DB persistence, profile serialization, and connection/policy
  capability probing.
- `backend-api/routes/admin.ts`
  Owns Admin routes for listing, creating, updating, testing, and deleting Kubernetes clusters.
- `backend-api/db_schema.sql`
  Owns the canonical schema for fresh installs.
- `backend-api/server.ts`
  Owns the idempotent migration block for existing installs.

### Queue / worker path

- `backend-api/redisQueue.ts`
  Owns the BullMQ queues and helper functions used by backend-api routes.
- `workers/provisioner/worker.ts`
  Owns the worker runtime, queue consumers, backend loading, and deploy-time orchestration.

### Kubernetes adapter path

- `workers/provisioner/backends/k8s.ts`
  Owns the Kubernetes adapter. For this follow-on, reuse the part 1 baseline helpers rather than
  redesigning them. The relevant existing surface includes:
  - `_policyFamilyConfig(...)`
  - `_policyName(...)`
  - `_buildDefaultDenyIngressPolicy(...)`
  - `_buildTrustedIngressPolicy(...)`
  - `_buildNetworkPolicies(...)`
  - `_upsertNetworkPolicy(...)`
  - `_reconcileNetworkPolicies(...)`

### Existing tests to extend

- `backend-api/__tests__/kubernetesClusters.test.ts`
  Current coverage for cluster-profile normalization and probed capability metadata.
- `backend-api/__tests__/admin.test.ts`
  Current Admin route coverage.
- `backend-api/__tests__/provisioning.test.ts`
  Current coverage for policy builders and deploy-time policy reconciliation.

## Phase 1: Persist Target-Level Ingress Settings And Status

### Objective

Add durable storage for desired operator ingress settings and their last apply result on the
Kubernetes cluster record, without changing the part 1 baseline-policy contract.

### Files

- `backend-api/db_schema.sql`
- `backend-api/server.ts`
- `backend-api/kubernetesClusters.ts`
- `backend-api/__tests__/kubernetesClusters.test.ts`

### Changes

1. Add two new columns to `kubernetes_clusters`:
   - `policy_settings jsonb not null default '{}'::jsonb`
   - `policy_settings_status jsonb not null default '{}'::jsonb`

2. Extend cluster-profile serialization so the profile can carry:
   - raw `policySettings`
   - raw `policySettingsStatus`
   - derived flags such as:
     - `customPolicyConfigured`
     - `customPolicyApplied`
     - `customIngressConfigured`

3. Treat `policy_settings` writes as **full replacement** of the target's operator-managed ingress
   rules. The stored normalization layer should therefore default omitted family buckets to empty
   arrays instead of preserving partial old state.

4. Add normalization helpers for ingress policy settings in `backend-api/kubernetesClusters.ts`.
   These should own the contract described in the management plan rather than duplicating validation
   in route handlers.

5. Keep the normalization split explicit:
   - submit-time deterministic validation in `backend-api/kubernetesClusters.ts`
   - queued apply-state tracking in the worker/apply path

6. Include desired-state identity in `policy_settings_status`, for example a deterministic hash of
   the normalized ingress payload. That gives the worker and future UI a stable way to know which
   saved state the latest status describes.

### Functions

In `backend-api/kubernetesClusters.ts`:

- `normalizeClusterInput(input, existing)` — **change**. Accept and persist `policySettings` and
  `policySettingsStatus` from the input/update path.
- `rowToProfile(row, opts)` — **change**. Map `policy_settings` / `policy_settings_status` onto the
  returned profile and derive the target-level custom-policy summary fields.
- `maskCluster(row)` — **change**. Ensure cluster API responses expose the new policy fields.
- `createKubernetesCluster(input)` — **change**. Include the new columns in the `INSERT` SQL.
- `updateKubernetesCluster(clusterId, input)` — **change**. Include the new columns in the `UPDATE`
  SQL.
- `normalizePolicySettings(input, existing)` — **new**. Entry point for normalizing the active
  ingress-only `policy_settings` object.
- `normalizeIngressPolicyRules(family, rules)` — **new**. Normalize, validate, and dedupe the
  per-family ingress rule list.
- `normalizePolicySettingsStatus(input, existing)` — **new**. Normalize queued/applying/applied/
  failed status payloads before persistence.
- `buildPolicySettingsHash(policySettings)` — **new**. Return a deterministic hash/string for the
  normalized desired ingress payload.
- `buildPolicySettingsSummary(policySettings, policySettingsStatus)` — **new**. Derive
  `customPolicyConfigured`, `customIngressConfigured`, and related UI summary fields.

### Tests

Extend `backend-api/__tests__/kubernetesClusters.test.ts` with cases for:

- legacy clusters that omit both new columns
- normalization of empty/default `policySettings`
- ingress rule rejection for invalid ports or ports outside the family baseline
- dedupe of equivalent ingress rules
- full-replacement behavior when one runtime family is omitted from the submitted payload
- derived summary fields on `rowToProfile(...)`

## Phase 2: Add Admin Read / Write Policy Settings Endpoints

### Objective

Expose explicit Admin endpoints for reading and updating target-scoped ingress policy settings
without mixing this feature into the generic cluster update payload.

### Files

- `backend-api/routes/admin.ts`
- `backend-api/kubernetesClusters.ts`
- `backend-api/__tests__/admin.test.ts`

### Changes

1. Add a read endpoint:

```text
GET /admin/kubernetes-clusters/:id/policy-settings
```

2. Add a write endpoint:

```text
PUT /admin/kubernetes-clusters/:id/policy-settings
```

3. Keep these endpoints target-specific rather than pushing policy settings through the existing
   generic `PUT /admin/kubernetes-clusters/:id` route. That avoids mixing policy-specific validation
   into every normal cluster edit.

4. When a write succeeds:
   - persist normalized `policy_settings`
   - seed `policy_settings_status` to a queued state for the new desired hash
   - enqueue a reconciliation job
   - return the updated cluster policy payload

5. The route should stay in desired-state mode:
   - invalid payload or missing cluster => reject
   - disconnected cluster => persist desired state and queue reconcile
   - `supportsNetworkPolicy === false` => persist desired state and queue reconcile; worker status
     will surface that the target cannot apply it

6. Follow the existing Admin route pattern by adding audit metadata and `monitoring.logEvent(...)`
   entries for policy-settings writes.

### Functions

In `backend-api/kubernetesClusters.ts`:

- `getKubernetesClusterPolicySettings(clusterId)` — **new**. Return the cluster row/profile fields
  needed by the read endpoint.
- `updateKubernetesClusterPolicySettings(clusterId, input)` — **new**. Normalize and persist
  `policy_settings`, seed `policy_settings_status`, and return the updated row/profile.
- `markKubernetesClusterPolicyStatus(clusterId, statusPayload)` — **new**. Shared helper for
  updating `policy_settings_status` from both backend-api and worker paths.

In `backend-api/routes/admin.ts`:

- route handler for `GET /kubernetes-clusters/:id/policy-settings` — **new**
- route handler for `PUT /kubernetes-clusters/:id/policy-settings` — **new**
- `createHttpError(...)` — **reuse** for route-level validation failures and missing clusters

### Tests

Extend `backend-api/__tests__/admin.test.ts` with cases for:

- `GET` returns normalized `policySettings`, `policySettingsStatus`, and summary fields
- `PUT` rejects invalid ingress rules
- `PUT` fully replaces prior ingress settings rather than merging them
- `PUT` persists normalized settings
- `PUT` seeds queued apply status
- `PUT` for a missing cluster returns `404`
- `PUT` against a disconnected or unsupported target still persists desired state and returns queued
  status for the new desired hash

## Phase 3: Add Queue And Worker Plumbing For Target Policy Reconciliation

### Objective

Reuse the repo's standard backend-api → BullMQ → worker → adapter pattern so ingress policy writes
are persisted first and applied asynchronously.

### Files

- `backend-api/redisQueue.ts`
- `workers/provisioner/worker.ts`
- `backend-api/routes/admin.ts`
- optional focused queue/worker tests if the repo already has a suitable pattern

### Changes

1. Add a dedicated BullMQ queue for target policy reconciliation instead of reusing the generic
   deploy queue. The job unit here is a **cluster target**, not an agent deployment.

2. Use a deterministic `jobId` keyed by cluster ID so repeated Admin saves coalesce naturally.

3. The write route should enqueue a cluster-level reconcile job after persisting the desired state.
   The job payload may include the newest desired hash for observability, but the worker must still
   reload the latest `policy_settings` and `policy_settings_status` from the database before acting.

4. The worker should:
   - load the latest cluster profile
   - mark status as `applying` for the desired hash it is actually about to process
   - reconcile operator ingress policy objects for the relevant namespaces/families
   - persist `applied` or `failed`

### Functions

In `backend-api/redisQueue.ts`:

- `policySettingsQueue` — **new**. Queue instance for target policy reconciliation.
- `addKubernetesPolicyReconcileJob(payload)` — **new**. Enqueue a cluster-target policy reconcile
  job.

In `workers/provisioner/worker.ts`:

- `runKubernetesPolicyReconcileJob({ clusterId })` — **new**. Cluster-level worker entry point.
- `loadBackend(runtimeFields)` — **reuse**. Use the existing k8s-target refresh behavior so the
  worker always loads the latest stored cluster profile.
- new `Worker("k8s-policy-settings", ...)` or equivalent queue consumer — **new**.

### Tests

Add focused coverage for:

- queue helper enqueues a deterministic target-scoped job
- repeated enqueue calls for one cluster coalesce to the same logical job id
- worker marks `policy_settings_status` as `applying`
- worker marks `policy_settings_status` as `failed` when reconcile throws

## Phase 4: Reconcile Operator Ingress Policy Objects

### Objective

Turn stored operator ingress rules into live additive `NetworkPolicy` objects without touching
Nora's baseline ingress bundle.

### Files

- `workers/provisioner/backends/k8s.ts`
- `workers/provisioner/worker.ts`
- `backend-api/__tests__/provisioning.test.ts`

### Changes

1. Add a dedicated operator-ingress builder per runtime family. These objects must stay separate
   from:
   - `*-default-deny-ingress`
   - `*-allow-trusted-ingress`

2. Reuse the same family selector logic as the baseline objects:
   - OpenClaw operator ingress selects the OpenClaw group
   - Hermes operator ingress selects the Hermes group

3. Support only the normalized ingress rule shape already defined in the management plan:
   - CIDR source
   - subset of family baseline ports

4. Add **pruning** behavior. If the stored rule list for a family becomes empty, the worker must
   delete that family's operator ingress object rather than leaving stale policy behind.

5. Add **namespace-change cleanup** behavior. If the cluster's OpenClaw or Hermes namespace has
   changed since the last successful apply, reconciliation must delete the previous operator policy
   object from the old namespace before declaring success in the new namespace.

### Functions

In `workers/provisioner/backends/k8s.ts`:

- `_buildOperatorIngressPolicy(runtimeFamily, namespace, rules)` — **new**. Convert normalized
  operator ingress rules into one additive `NetworkPolicy` object.
- `_buildOperatorIngressPeers(rules)` — **new, optional**. Convert normalized CIDRs into ingress
  `_from` peers.
- `_buildOperatorIngressPorts(rules)` — **new, optional**. Convert normalized port sets into ingress
  port stanzas.
- `_operatorPolicyName(runtimeFamily, suffix)` — **new, optional**. Keep operator policy names
  separate from baseline names.
- `_deleteNetworkPolicyIfPresent(name, namespace)` — **new**. Needed because operator-object
  reconciliation must prune, not only upsert.
- `_reconcileOperatorIngressPolicies({ runtimeFamily, namespace, policySettings })` — **new**.
  Upsert the operator ingress object when rules exist, delete it when the rule list is empty.
- `_cleanupStaleOperatorIngressPolicies({ runtimeFamily, currentNamespace, previousNamespaces })`
  — **new**. Delete old operator-managed objects left behind after namespace changes.

In `workers/provisioner/worker.ts`:

- `runKubernetesPolicyReconcileJob(...)` — **change**. Call the ingress reconcile path for both
  OpenClaw and Hermes namespaces/families on the target.

### Tests

Extend `backend-api/__tests__/provisioning.test.ts` with cases for:

- building an operator OpenClaw ingress object with the expected selector and ports
- building an operator Hermes ingress object with the expected selector and ports
- leaving baseline policy names and shapes unchanged
- deleting the operator ingress object when the rule list is empty
- applying updated ingress rules idempotently on repeated reconcile
- deleting stale operator policy objects from previous namespaces when target namespace settings
  change

## Phase 5: Persist Target-Level Apply Status

### Objective

Finalize the target-level status payload the Admin UI will consume for the active ingress-only
feature.

### Files

- `workers/provisioner/worker.ts`
- `backend-api/kubernetesClusters.ts`
- `backend-api/routes/admin.ts`
- `backend-api/__tests__/kubernetesClusters.test.ts`
- `backend-api/__tests__/admin.test.ts`

### Changes

1. Persist apply outcomes to `policy_settings_status`, for example:
   - `state: queued | applying | applied | failed`
   - `desiredHash`
   - `appliedHash`
   - `lastAppliedNamespaces`
   - `customPolicyIssue`
   - `customPolicyAppliedAt`

2. Make the status semantics exact:
   - `queued` => latest desired hash saved, no worker attempt started yet
   - `applying` => worker started reconciling that desired hash
   - `applied` => worker reconciled that desired hash and verified expected operator objects with
     read-back
   - `failed` => worker attempted that desired hash but could not verify the expected result

3. Expose that status cleanly through the Admin read endpoint and cluster profile response.

4. Keep target-level summary separate from the per-agent baseline `networkPolicyStatus`.

5. Optionally persist generic warnings if reconciliation wants to report advisory information, but
   ingress-only v1 does not depend on the selector-based warning flow preserved in the deferred
   egress appendix.

### Functions

In `workers/provisioner/worker.ts`:

- `runKubernetesPolicyReconcileJob(...)` — **change**. Persist `applied` vs `failed` and return the
  final target-level status payload.

In `backend-api/kubernetesClusters.ts`:

- `buildPolicySettingsSummary(...)` — **change**. Include any derived booleans/messages the Admin UI
  needs from the ingress-only status payload.

### Tests

Add coverage for:

- queued/applying/applied/failed status surviving round-trip through `policy_settings_status`
- new saves resetting status to queued under a new desired hash even if an older desired hash had
  previously applied successfully
- failed reconcile surfacing `customPolicyIssue`
- successful reconcile surfacing `customPolicyApplied`

## Phase 6: Regression And Live Verification

### Objective

Prove the new management layer does not break the existing baseline k8s policy path and that
operator-managed ingress objects reconcile as expected.

### Files

- `backend-api/__tests__/kubernetesClusters.test.ts`
- `backend-api/__tests__/admin.test.ts`
- `backend-api/__tests__/provisioning.test.ts`
- optional live/manual verification notes in the plan folder if the team wants them captured

### Changes

1. Run the focused backend tests for:
   - cluster/profile normalization
   - Admin read/write policy routes
   - ingress policy builder / reconcile behavior

2. Verify deploy-time compatibility:
   - a fresh OpenClaw deploy on a target with saved `policy_settings` still applies baseline policy
   - the same deploy also sees the target's operator ingress objects in place

3. Verify prune behavior live or through mocks:
   - save rules
   - reconcile
   - remove rules
   - confirm the `nora-*-operator-allow-ingress` objects are deleted while baseline objects remain

4. Verify repeated saves remain idempotent:
   - save the same normalized rule set twice
   - confirm the second reconcile produces no baseline drift and no duplicate operator objects

5. Verify desired-state behavior under degraded conditions:
   - save rules while the target is disconnected or unsupported
   - confirm the rules persist
   - confirm status eventually reports failed for that desired hash rather than silently discarding
     the desired state

### Acceptance

- targeted tests pass for the new storage/API/reconcile paths
- operator ingress objects are additive and pruned correctly
- baseline objects remain untouched
- target-level status distinguishes queued, applying, applied, and failed states

## Stage B: Frontend Follow-On To Plan Now

Full frontend implementation is still a later slice, but the UI contract should be planned now so
the backend phases above expose the right fields.

### Stage B1: Split The Current One-Page Kubernetes Admin Surface

The current implementation in `admin-dashboard/pages/kubernetes.tsx` mixes three concerns in one
screen:

- cluster registry/listing
- cluster detail/status
- cluster configuration editing

The frontend follow-on should split that into a list page and a detail page.

#### Intended routes

- `admin-dashboard/pages/kubernetes.tsx` or `admin-dashboard/pages/kubernetes/index.tsx`
  Registry/list page for **registered clusters**
- `admin-dashboard/pages/kubernetes/[id].tsx`
  Detail page for one selected cluster

#### Registry page responsibilities

The `/kubernetes` page should:

- remain the entry point linked from the admin sidebar
- keep the existing **Add cluster** button in the header area
- show registered clusters in a scan-friendly list/table/card layout
- navigate to `/kubernetes/[id]` when a cluster is selected

This page should stop rendering the full edit form inline.

#### Detail page responsibilities

The `/kubernetes/[id]` page should follow the broad pattern already used by detail pages such as
`admin-dashboard/pages/fleet/[id].tsx`:

- back link to `/kubernetes`
- read-only summary header
- status badges / summary metrics
- tabbed content sections below the header

### Stage B2: Detail Page Tabs

The detail page should contain three tabs:

- `Overview`
- `Cluster Config`
- `Network Policy`

#### Overview tab

Read-only status summary. Likely content:

- provider / label / cluster name
- enabled / connected / last test status
- exposure mode
- fallback / OpenClaw / Hermes namespaces
- baseline NetworkPolicy support summary
- custom policy status summary

#### Cluster Config tab

This tab should host the **existing cluster form** currently implemented in
`admin-dashboard/pages/kubernetes.tsx`.

Expected refactor:

- extract the current form and action controls into reusable cluster-config components
- render those components inside the `Cluster Config` tab
- preserve existing actions such as save, test, enable/disable, and delete where they make sense

The goal here is primarily layout cleanup, not a schema change.

#### Network Policy tab

This tab should consume the backend contract from Stages A1-A6.

Expected content:

- baseline status summary
- current custom ingress apply state
- OpenClaw ingress rule editor section
- Hermes ingress rule editor section

It should not include any egress UI in this version.

### Stage B3: Frontend Data And Save Flow

When frontend work begins, the likely touchpoints will be:

- `admin-dashboard/pages/kubernetes.tsx`
- `admin-dashboard/pages/kubernetes/[id].tsx`
- extracted Kubernetes detail / config / policy components under `admin-dashboard/components/`
- an API client for `GET/PUT /admin/kubernetes-clusters/:id/policy-settings`

The expected behavior is:

- `/kubernetes` loads the registered-cluster registry
- `/kubernetes/[id]` loads cluster detail plus policy settings/status
- the Network Policy tab edits a **full replacement** payload locally
- save issues `PUT /admin/kubernetes-clusters/:id/policy-settings`
- the tab reflects `queued`, `applying`, `applied`, and `failed` for the latest desired hash

This frontend stage does not change the backend-first priority, but it is worth keeping visible now
because it explains why the backend response needs stable rule ids, summary booleans, explicit
desired-hash/status metadata, and a cluster-detail-friendly response shape.

## Recommended First Slice

Build **Phases 1 and 2** together first.

That produces a stable backend contract for:

- `policy_settings`
- `policy_settings_status`
- normalized ingress rule shapes
- target-level Admin read/write endpoints

Once that contract exists, the queue/worker and adapter phases can build on it without revisiting
the payload shape.

## Deferred Appendix: Future Egress Follow-On (Do Not Use For Current Feature Development)

This appendix preserves earlier egress implementation ideas so they can be revisited later. It is
**not approved scope** for the current feature and **must not be used when developing the current
implementation**.

### Deferred Future Data Model / API Extension

Earlier drafts assumed the active phases might eventually expand to include:

- `normalizeEgressPolicyRules(family, rules)` — normalize, validate, and dedupe per-family egress
  rule lists
- `customEgressConfigured` in `buildPolicySettingsSummary(...)`
- egress payloads on `GET /admin/kubernetes-clusters/:id/policy-settings`
- egress validation on `PUT /admin/kubernetes-clusters/:id/policy-settings`

Those ideas are preserved here only for future revisit.

### Deferred Future Reconcile Phase

Earlier drafts also assumed a separate egress reconcile phase:

- add `_buildOperatorEgressPolicy(runtimeFamily, namespace, rules)`
- add `_buildOperatorEgressPeers(rule)`
- add `_buildOperatorEgressPorts(rule)`
- add `_reconcileOperatorEgressPolicies({ runtimeFamily, namespace, policySettings })`
- call the operator egress reconcile path from `runKubernetesPolicyReconcileJob(...)`

The preserved objective was:

- turn stored operator egress rules into additive `NetworkPolicy` objects for OpenClaw and Hermes
- use only rule shapes Kubernetes can represent directly
- keep operator egress objects separate from Nora baseline objects

### Deferred Future Warning Extension

Earlier drafts also expected selector-based warning support for future egress work:

- `_matchNamespaces(selector)` — resolve a `namespaceSelector` against the live cluster
- `_matchPods(namespace, selector)` — resolve a `podSelector` within a namespace
- `_buildOperatorPolicyWarnings(...)` — attach zero-match selector warnings keyed by rule id

The preserved rationale was:

- selector-based egress rules can apply successfully while matching zero endpoints
- those cases should be surfaced as warnings rather than hard failures

That warning model remains deferred together with egress.
