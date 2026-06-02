# ClawHub Deletion Implementation Plan

## Purpose

This document translates the product plan in `plans/clawhub_deletion/clawhub-deletion-plan.md` into an engineer-facing implementation sequence. It is intended to be detailed enough that an engineer new to this codepath can use it as a working skeleton for the feature.

The feature has two goals:

1. Add runtime deletion of ClawHub skills, including orphaned runtime skills.
2. Update the ClawHub UI so operators can see installed/drifted skills and delete them with the same overall interaction model used for install.

## Existing Code To Reuse

### Backend

- `backend-api/routes/clawhub.ts`
  Owns ClawHub REST routes, route-level validation, and install job enqueueing.
- `backend-api/redisQueue.ts`
  Owns the shared BullMQ ClawHub mutation queue and job lookup helpers.
- `workers/provisioner/worker.ts`
  Owns the install worker, runtime exec helpers, and restart-time reconciliation.
- `agent-runtime/lib/clawhubReconciliation.js`
  Owns normalization helpers for saved skills and the current "DB saved but runtime missing" computation.
- `backend-api/__tests__/clawhub.test.ts`
  Route tests for browse/detail/install/job polling.
- `backend-api/__tests__/clawhubReconciliation.test.ts`
  Reconciliation helper tests.

### Frontend

- `frontend-dashboard/components/agents/openclaw/ClawHubTab.tsx`
  Main stateful ClawHub agent tab.
- `frontend-dashboard/components/agents/openclaw/SkillGrid.tsx`
  Catalog grid.
- `frontend-dashboard/components/agents/openclaw/SkillCard.tsx`
  Catalog card UI, already supports `installed`.
- `frontend-dashboard/components/agents/openclaw/SkillDetailPanel.tsx`
  Detail/review panel.
- `frontend-dashboard/components/agents/openclaw/SkillSelectionTray.tsx`
  Existing install tray to extend for delete mode.
- `frontend-dashboard/components/agents/OpenClawTab.tsx`
  OpenClaw shell; use current branch and `pr-174` as references for tab framing.
- `frontend-dashboard/pages/agents/[id].tsx`
  Contains the current "ClawHub Install Complete" restart banner shown after install success.

### `pr-174` UI Reference

The current branch already contains most of the catalog internals. The local `pr-174` branch is mainly useful as a reference for the broader OpenClaw tab shell and surrounding agent-page presentation.

Files to compare while implementing:

- `frontend-dashboard/components/agents/OpenClawTab.tsx`
- `frontend-dashboard/pages/agents/[id].tsx`
- `frontend-dashboard/components/agents/openclaw/ChatPanel.tsx`

Do not expect to port large chunks from `pr-174` for the catalog internals; the current branch already has those.

## Phase 1: Normalize The Backend Data Model

### Objective

Create one shared notion of ClawHub skill state that can answer:

- what Nora thinks should exist,
- what is actually installed,
- whether the skill is healthy, missing from runtime, or orphaned in runtime.

### Files

- `agent-runtime/lib/clawhubReconciliation.js`
- `backend-api/routes/clawhub.ts`
- `workers/provisioner/worker.ts`
- optionally a new helper file under `backend-api/` or `agent-runtime/lib/` if the merged-state logic feels too large for `routes/clawhub.ts`

### Changes

1. Expand the reconciliation helper module.

Add functions alongside:

- `normalizeSavedSkillEntry`
- `normalizeSavedSkillEntries`
- `computeMissingSavedSkills`

New helpers should include something close to:

- `mapInstalledClawhubSkills(lockfileEntries)`
- `computeOrphanedInstalledSkills(savedSkills, installedSkills)`
- `mergeClawhubSkillState(savedSkills, installedSkills, pendingJobs?)`
- `removeSavedClawhubSkillEntry(entries, slug, author?)`

The merged output shape should match the product plan:

```ts
type MergedClawhubSkillState = {
  slug: string;
  version: string;
  saved: boolean;
  installed: boolean;
  source: "clawhub";
  author: string;
  pagePath: string;
  installedAt: string | null;
  status: "healthy" | "missing_runtime" | "orphaned_runtime";
};
```

2. Keep normalization logic centralized.

Do not duplicate saved-entry normalization in both:

- `backend-api/routes/clawhub.ts`
- `workers/provisioner/worker.ts`

Instead, route code and worker code should both lean on the shared helper module.

3. Preserve richer skill identity than `slug` alone.

Even if runtime install/uninstall remains slug-driven, Nora should continue to preserve:

- `author`
- `pagePath`

for saved metadata and UI matching.

Implementation guidance:

- runtime mutation commands may continue to use `slug`,
- saved-state mutation and UI display should preserve `author + slug` and `pagePath` when available.

4. Add DB mutation helper(s) for saved state.

Today `workers/provisioner/worker.ts` has:

- `appendSavedClawhubSkill(agentId, slug, skillEntry)`

Add the inverse helper, likely in the same file first and then extract later if it grows:

- `removeSavedClawhubSkill(agentId, slug, skillEntry?)`

This helper should:

- load `agents.clawhub_skills`,
- normalize entries,
- remove the matching entry if present,
- no-op cleanly if no saved entry exists.

That no-op behavior is what enables orphaned runtime deletion to use the same delete flow.

### Tests

Extend `backend-api/__tests__/clawhubReconciliation.test.ts` with cases for:

- orphaned runtime skills,
- merged healthy/missing/orphaned states,
- removing a saved skill entry,
- duplicate saved entries collapsing correctly before delete.

## Phase 2: Expand The ClawHub API Contract

### Objective

Change the agent-skills endpoint from "raw runtime lockfile list" into "operator-facing merged health view," and add delete enqueueing.

### Files

- `backend-api/routes/clawhub.ts`
- `backend-api/__tests__/clawhub.test.ts`

### Changes

1. Refactor route-local helper naming.

`validateInstallableAgent(agent)` is now doing generic OpenClaw runtime validation, not just install validation. Rename it to something like:

- `validateClawhubMutableAgent(agent)`

and reuse it for both install and delete.

2. Replace the current `GET /agents/:agentId/skills` response.

Current behavior:

- loads the agent row,
- reads `.clawhub/lock.json` via `runContainerCommand`,
- returns only `skills: normalizeInstalledSkillsLockfile(parsed)`.

New behavior:

- load the agent row,
- normalize `agent.clawhub_skills`,
- read installed lockfile skills,
- return merged skill state.

Implementation note:

Keep this endpoint focused on stable skill health state. Temporary pending install/delete UI state should come from job polling and be overlaid in the frontend rather than embedded into the stable skills response.

3. Add `POST /agents/:agentId/skills/:slug/delete`.

This should mirror the install route structure:

- load owned agent,
- validate runtime eligibility,
- normalize slug,
- ensure ClawHub CLI exists if we want symmetry with install and uninstall depends on the CLI,
- check for in-flight delete job,
- block or coalesce conflicting install job,
- enqueue delete job.

The payload can stay minimal:

```json
{
  "author": "steipete",
  "pagePath": "steipete/github"
}
```

but the route should not require that the DB contain the entry.

4. Extend `GET /jobs/:jobId`.

Current job status payload has:

- `jobId`
- `agentId`
- `slug`
- `status`
- `error`
- `completedAt`

Extend it to include:

- `operation: "install" | "delete"`

That lets the frontend reuse one polling loop for both job types. Because install and delete now share the same queue, a bare `jobId` can be resolved from one place.

Add an ownership check:

- load the job,
- confirm the job's `agentId` belongs to `req.user.id`,
- only then return job status.

5. Split error handling cleanly.

`sendInstallError` should either be generalized to `sendClawhubMutationError`, or a delete-specific sibling should be added. Avoid install-only wording in delete responses.

### Tests

Add route tests for:

- merged skills response with healthy and orphaned entries,
- delete route rejects non-running / non-openclaw agents,
- delete route reuses existing in-flight delete job,
- delete route blocks or coalesces against conflicting install job,
- delete route enqueues successfully for an orphaned runtime skill,
- job status response returns `operation`.

## Phase 3: Generalize The Shared ClawHub Queue And Queue Lookup Helpers

### Objective

Turn the current install-only queue into a shared ClawHub mutation queue with explicit operation typing and conflict detection.

### Files

- `backend-api/redisQueue.ts`
- `backend-api/routes/clawhub.ts`
- `workers/provisioner/worker.ts`

### Changes

1. Replace the install-only queue with a shared ClawHub mutation queue.

Current queue:

- `const clawhubInstallsQueue = new Queue("clawhub-installs", ...)`

Replace it with a shared queue:

- `const clawhubJobsQueue = new Queue("clawhub-jobs", ...)`

Use the current install timeout defaults initially unless delete proves to need a different one.

2. Generalize queue helpers around `operation`.

Current helpers:

- `addClawhubInstallJob`
- `findInFlightClawhubInstallJob`
- `getClawhubInstallJob`
- `getClawhubInstallJobStatus`

Replace or generalize them into something like:

- `addClawhubJob(payload)`
- `findInFlightClawhubJob(agentId, slug, operation?)`
- `getClawhubJob(jobId)`
- `getClawhubJobStatus(jobId)`

`findInFlightClawhubJob(agentId, slug, operation?)` should be able to return either:

- only same-operation jobs when `operation` is provided,
- or any in-flight mutation for the same `(agentId, slug)` when the route wants conflict detection.

Its result should include:

- operation,
- job id,
- status.

3. Keep job payloads parallel.

Install payload today:

- `agentId`
- `slug`
- `skillEntry`
- `persistOnSuccess`

Shared ClawHub job payload should look like:

- `agentId`
- `slug`
- `operation`
- `skillEntry`
- `persistOnSuccess` for install jobs
- `removeSavedEntryOnSuccess` for delete jobs

For orphaned runtime skills, `removeSavedEntryOnSuccess` can remain `true`; the worker helper will no-op if there is no saved entry.

### Tests

Add unit coverage in `backend-api/__tests__/clawhub.test.ts` via mocked `redisQueue` exports. If `redisQueue.ts` has direct tests elsewhere, add queue lookup tests there too.

## Phase 4: Implement The Delete Worker

### Objective

Add the runtime delete worker with the same verify-before-persist guarantees as install.

### Files

- `workers/provisioner/worker.ts`
- `backend-api/redisQueue.ts`

### Changes

1. Extract shared ClawHub runtime helpers.

The following are already present in `workers/provisioner/worker.ts` and should be reused:

- `readInstalledClawhubSkills`
- `ensureClawhubCli`
- `createClawhubInstallLogger` (rename/generalize)

Refactor `createClawhubInstallLogger` into something like:

- `createClawhubSkillJobLogger({ jobId, agentId, slug, operation })`

so install and delete share the same logging shape.

2. Add runtime uninstall helper.

Add a helper near the install helper block:

- `uninstallClawhubSkill(provisioner, containerId, slug)`

Implementation:

- `await ensureClawhubCli(...)`
- run `cd /root/.openclaw/workspace && clawhub uninstall <slug> --no-input` if supported
- if the CLI does not accept `--no-input`, use the simplest non-interactive uninstall invocation confirmed in manual verification
- use the same timeout and env flags as install unless uninstall needs its own constant
- after uninstall returns, re-read and verify installed skills with the same retry-friendly lockfile read helper rather than a single immediate check

3. Add delete worker.

Generalize the install worker into a shared ClawHub mutation worker:

- queue name: `clawhub-jobs`
- concurrency: `1`
- lock duration / renew time: parallel to the current install worker

Suggested structure:

```ts
const clawhubJobsWorker = new Worker("clawhub-jobs", async (job) => {
  // validate job payload
  // branch on job.data.operation
  // load agent
  // validate runtime family + running state
  // load provisioner
  // run install or delete flow
  // verify lockfile state
  // persist DB mutation if needed
  // return operation result
});
```

4. Keep install and delete subflows explicit within the shared worker.

Do not collapse install/delete behavior into one unreadable block. Use helpers or per-operation branches such as:

- `runClawhubInstallJob(...)`
- `runClawhubDeleteJob(...)`

The shared worker should mainly:

- validate payload,
- load the agent/runtime,
- dispatch by `operation`,
- emit consistent logging/status payloads.

Treat this as the implementation decision, not just a suggestion: one shared worker with explicit install/delete helper branches.

5. Make delete tolerant of orphaned runtime skills.

The worker must not fail just because the DB has no matching `clawhub_skills` entry. That is expected for an orphaned runtime deletion.

6. Extend job completion/failure logging.

Install currently has:

- `clawhubInstallWorker.on("failed", ...)`
- `clawhubInstallWorker.on("completed", ...)`

Replace those with shared worker listeners keyed off `operation` in the log payload.

### Verification Cases

Manual verification should cover:

- saved + installed skill delete,
- runtime-only orphaned skill delete,
- delete when skill is already absent,
- failed uninstall leaving DB untouched,
- successful uninstall removing lockfile entry and DB entry.

## Phase 5: Extend Reconciliation

### Objective

Keep restart/provision reconciliation aligned with DB truth without causing destructive surprises during normal page viewing.

### Files

- `agent-runtime/lib/clawhubReconciliation.js`
- `workers/provisioner/worker.ts`
- possibly `backend-api/routes/clawhub.ts` if a future manual sync action is added later

### Changes

1. Expand reconciliation computation.

Current worker path only does:

- `computeMissingSavedSkills(savedSkills, installedSkills)`

Add orphan detection:

- `computeOrphanedInstalledSkills(savedSkills, installedSkills)`

2. Update `reconcileSavedClawhubSkills`.

This function should be renamed because it will no longer only install saved skills. Suggested rename:

- `reconcileClawhubSkills`

New behavior:

- if DB-only skills exist, install them,
- if runtime-only skills exist, uninstall them,
- keep logging explicit about which path ran.

3. Keep reconciliation at restart/provision boundaries.

Do not add automatic reconciliation on page load. The existing provisioner call site is already the right place to begin:

- after a fresh deploy,
- after agent restart if a restart path later calls into the same helper.

4. Preserve best-effort semantics.

If one orphan uninstall fails during reconciliation, log it and continue processing other skills just like the current install reconciliation loop.

### Tests

Extend `backend-api/__tests__/clawhubReconciliation.test.ts` and add worker-level tests if there is an existing pattern for `workers/provisioner/worker.ts`. At minimum ensure helper coverage exists for both missing-saved and orphaned-runtime sets.

## Phase 6: Implement Frontend Data Model Changes

### Objective

Teach the ClawHub tab to render merged runtime/DB health data rather than only raw installed slug lists.

### Files

- `frontend-dashboard/components/agents/openclaw/ClawHubTab.tsx`
- `frontend-dashboard/components/agents/openclaw/SkillCard.tsx`
- `frontend-dashboard/components/agents/openclaw/SkillGrid.tsx`
- `frontend-dashboard/components/agents/openclaw/SkillSelectionTray.tsx`
- optionally add a new component such as `InstalledSkillGrid.tsx` or `InstalledSkillList.tsx`

### Changes

1. Replace the current installed-skill state type.

Current local types in `ClawHubTab.tsx`:

- `type InstalledSkill = { slug: string; version: string }`
- `type InstalledSkillsResponse = { skills?: InstalledSkill[] }`

Replace with a merged type, e.g.:

```ts
type AgentClawhubSkill = {
  slug: string;
  version: string;
  saved: boolean;
  installed: boolean;
  source: "clawhub";
  author: string;
  pagePath: string;
  installedAt: string | null;
  status: "healthy" | "missing_runtime" | "orphaned_runtime";
};
```

2. Split install and delete selection state.

Current selection state is install-only:

- `selectedSkills`
- `selectionBusySlug`
- `jobStatuses`
- `installError`

Add delete-specific state:

- `selectedDeleteSkills`
- `deleteBusySlug`
- `deleteError`

Keep install and delete isolated so one flow does not pollute the other.

3. Generalize job tracking.

Current `InstallJobStatus` should become a generic ClawHub mutation job type with:

- `operation`
- `status`
- `error`
- `completedAt`

The polling effect should update both install and delete UI by reading from the shared ClawHub jobs endpoint.

Important boundary:

- stable skill state comes from `GET /api/clawhub/agents/:agentId/skills`
- temporary pending state comes from the local job-status map populated by polling

4. Derive view models in `ClawHubTab.tsx`.

From the merged API response compute:

- `healthyInstalledSkills`
- `orphanedRuntimeSkills`
- `catalogInstalledSlugs`

Those three derived sets are what drive:

- installed section,
- drift badges,
- disabled install selection in the catalog.

## Phase 7: Build The Installed Skills UI And Delete Flow

### Objective

Add the installed-skills section above the catalog and wire explicit deletion.

### Files

- `frontend-dashboard/components/agents/openclaw/ClawHubTab.tsx`
- `frontend-dashboard/components/agents/openclaw/SkillSelectionTray.tsx`
- `frontend-dashboard/components/agents/openclaw/SkillCard.tsx`
- optionally new installed-skill-specific components under `frontend-dashboard/components/agents/openclaw/`

### Changes

1. Add an installed skills surface above the existing catalog.

This can be:

- a new `InstalledSkillsPanel` component, or
- a small section rendered inline in `ClawHubTab.tsx`

Responsibilities:

- render healthy installed skills,
- render orphaned runtime skills with drift styling,
- allow selection for delete,
- open the existing detail panel when clicked.

2. Reuse `SkillDetailPanel` for delete review.

`SkillDetailActionState` already exists. Extend action labels and callbacks for delete mode:

- `Delete skill`
- `Remove from delete selection`
- `Installed`

No new detail panel pattern should be introduced.

3. Extend `SkillSelectionTray` with delete mode.

Current prop:

- `mode?: "deploy" | "install"`

Change it to something like:

- `mode?: "deploy" | "install" | "delete"`

Then add delete-specific copy:

- tray title/count,
- action button label,
- destructive styling if desired,
- text that uses the same restart recommendation as install.

4. Decide whether to reuse `SkillCard` or add a sibling for installed items.

`SkillCard.tsx` already knows how to render an `Installed` pill for catalog entries.

Recommendation:

- keep `SkillCard` for catalog browsing,
- create a lightweight installed-skill row/card component for the top section so delete affordances and drift states stay explicit.

5. Add delete handlers in `ClawHubTab.tsx`.

Suggested new handlers:

- `toggleDeleteSelection(skill)`
- `removeDeleteSelectionBySlug(slug)`
- `clearDeleteSelections()`
- `handleDeleteSelected()`

`handleDeleteSelected()` should:

- POST `/api/clawhub/agents/:agentId/skills/:slug/delete`
- update job state map,
- poll until success/failure,
- reload installed skills,
- remove the deleted skill from selection,
- call the same restart-success callback pattern already used for install.

6. Keep restart messaging identical in tone to install.

Current install UX references:

- `frontend-dashboard/components/agents/openclaw/SkillSelectionTray.tsx`
- `frontend-dashboard/components/agents/openclaw/ClawHubTab.tsx`
- `frontend-dashboard/pages/agents/[id].tsx`

Delete success should set the same "restart your agent session" recommendation, just with delete-specific copy.

## Phase 8: Reuse Existing Restart Recommendation Pattern

### Objective

Do not invent a second restart recommendation pattern for delete.

### Files

- `frontend-dashboard/components/agents/OpenClawTab.tsx`
- `frontend-dashboard/pages/agents/[id].tsx`
- `frontend-dashboard/components/agents/openclaw/ClawHubTab.tsx`

### Changes

1. Inspect the current callback path.

Today:

- `ClawHubTab` calls `onInstallSuccess?.()`
- `OpenClawTab` forwards `onClawhubInstallSuccess`
- `pages/agents/[id].tsx` shows the "ClawHub Install Complete" banner

2. Keep the success notification path aligned with install.

At minimum:

- delete success should show the same upper-right notification/toast recommendation as install,
- install and delete should share restart recommendation wording.

If engineers choose to generalize the callback path as part of that cleanup, rename install-specific props to mutation-neutral ones:

- `onClawhubInstallSuccess` -> `onClawhubMutationSuccess`
- `onInstallSuccess` -> `onMutationSuccess`

3. Treat the page-level banner as optional cleanup, not a requirement for v1.

If product wants stronger parity later, the page-level banner in `pages/agents/[id].tsx` can be generalized, but the required behavior for this feature is the same restart recommendation toast/notification pattern as installation.

## Phase 9: Test Plan

### Backend Tests

- `backend-api/__tests__/clawhub.test.ts`
  Add route coverage for merged skill state and delete enqueueing.
- `backend-api/__tests__/clawhubReconciliation.test.ts`
  Add merged-state and orphan computation coverage.
- add worker tests if a suitable test pattern exists for `workers/provisioner/worker.ts`

Must-cover backend scenarios:

- healthy merged skill state,
- missing runtime state,
- orphaned runtime state,
- delete queued for saved skill,
- delete queued for orphaned runtime skill,
- duplicate in-flight delete job reused,
- conflicting install job blocks delete,
- delete success removes DB entry if present,
- delete success keeps DB stable if no entry exists,
- delete failure leaves DB untouched.
- job status lookup rejects jobs for agents the current user does not own.

### Frontend Tests

Add tests wherever the current frontend test strategy for `frontend-dashboard` lives. If there are no component tests for this area yet, add focused render/interaction tests around the new installed-skill surface and keep them narrow.

Must-cover frontend scenarios:

- installed skills section renders above catalog,
- healthy installed catalog skills remain non-selectable for install,
- orphaned runtime skills render with drift state and are deletable,
- delete tray mode uses delete-specific labels,
- successful delete triggers the same restart recommendation path as install,
- failed delete shows an error without dropping local state.
- pending install/delete state is derived from polled job status, not embedded into the stable skills response.

### Manual Verification

1. Install a skill and confirm current behavior still works.
2. Delete a healthy saved+installed skill.
3. Delete an orphaned runtime skill.
4. Restart the agent and confirm reconciliation installs DB-only skills.
5. Restart the agent and confirm reconciliation removes runtime-only orphaned skills.
6. Confirm the agent page banner uses the same restart recommendation for install and delete.
6. Confirm delete success uses the same upper-right notification/toast restart recommendation as install.

## Phase 10: Suggested Delivery Order

Implement in this order to minimize thrash:

1. Shared reconciliation helpers and merged-state computation.
2. Route changes for merged skill state.
3. Queue additions and delete route enqueueing.
4. Delete worker.
5. Restart/provision reconciliation expansion.
6. Frontend type changes in `ClawHubTab.tsx`.
7. Installed-skill UI section and delete tray mode.
8. Restart banner generalization.
9. Backend tests.
10. Frontend tests and manual validation.

## Out Of Scope For This Pass

- aggressive cleanup of non-ClawHub-owned side effects,
- adoption workflows beyond explicit orphan delete,
- automatic drift repair on tab load,
- redesigning the broader OpenClaw tab shell beyond the `pr-174` alignment already captured on this branch.
Use the same upper-right notification/toast pattern as install for delete success.

Do not require a new page-level banner for delete unless product later decides both install and delete should share one larger agent-page restart banner.
