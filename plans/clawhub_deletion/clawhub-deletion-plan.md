# ClawHub Deletion Plan

## Goal

Add safe ClawHub skill deletion for existing OpenClaw agents while reusing the `pr-174` UI direction for installed-skill visibility, disabled install selection for already-installed skills, and multi-select deletion.

## Working Model

Treat `agents.clawhub_skills` as Nora's desired-state source of truth and the OpenClaw workspace as the reconciled runtime state.

- Database:
  `agents.clawhub_skills` is the list Nora believes should exist for the agent.
- Runtime:
  The workspace filesystem plus `.clawhub/lock.json` is the actual installed-state snapshot inside the running container.
- Reconciliation:
  Workers drive runtime toward the database, not the other way around.

This already matches the install flow in spirit:

1. An install job runs `clawhub install <slug>`.
2. The worker verifies the slug appears in `.clawhub/lock.json`.
3. The worker persists the skill into `agents.clawhub_skills`.
4. Reconciliation installs any DB-saved skills that are missing from runtime.

Deletion should mirror that:

1. A delete request targets one or more saved or runtime-present skills.
2. The worker runs `clawhub uninstall <slug>` in the runtime.
3. The worker verifies the slug is absent from `.clawhub/lock.json`.
4. The worker removes the entry from `agents.clawhub_skills`.

## Frontend

### Baseline To Reuse

- `frontend-dashboard/components/agents/openclaw/ClawHubTab.tsx`
  Keep the current catalog/search/detail shell and align the deletion UX with the `pr-174` treatment of installed skills.
- `frontend-dashboard/components/agents/openclaw/SkillGrid.tsx`
  Keep this for catalog browsing.
- `frontend-dashboard/components/agents/openclaw/SkillDetailPanel.tsx`
  Reuse this for review/confirmation before delete.
- `frontend-dashboard/components/agents/openclaw/SkillSelectionTray.tsx`
  Extend this for delete mode instead of introducing a second tray pattern.

### UI Structure

The ClawHub tab should be organized into two clear surfaces:

1. Installed skills section:
   Shows skills already present on the agent and is the only place where delete selection is allowed.
2. Catalog section:
   Shows registry skills for browsing and install, with already-installed skills clearly marked and not selectable for install.

### Intended User Flow

1. User opens the ClawHub tab.
2. Installed skills appear in a dedicated section above the browse/search catalog.
3. User selects one or more installed skills for deletion.
4. Selected skills appear in the existing tray pattern, now in delete mode.
5. User confirms the destructive action.
6. Nora queues delete jobs and shows per-skill job state.
7. On success, the installed list refreshes and the UI prompts for restart or revalidation if needed.

### Frontend Requirements

- Match `pr-174` as closely as practical for installed-skill display and disabled install selection.
- Do not allow install selection for skills already in a healthy installed state.
- Keep install and delete selections visually distinct if both modes can exist in the same view.
- Show per-skill pending/running/success/failed status.
- Surface drift states instead of hiding them.
- Surface `orphaned_runtime` as drift, but still allow the operator to explicitly delete it.
- Preserve the existing detail panel pattern so README/requirements remain inspectable before delete.

### Frontend Data Contract

This contract is not just for rendering a list of skills. It is meant to tell the Nora operator whether each ClawHub skill on an agent is healthy relative to Nora's database state.

The frontend therefore needs a merged DB/runtime view rather than only the raw lockfile view returned today.

- DB view:
  What Nora believes should exist for the agent.
- Runtime view:
  What is actually installed in the running OpenClaw workspace.
- Merged view:
  The operator-facing health view that compares those two sources and makes drift visible.

Without that merged view, the UI can show a list of skills, but it cannot accurately tell the operator whether Nora and the live agent agree on the current state of those skills.

```json
{
  "skills": [
    {
      "slug": "github",
      "version": "2.1.0",
      "saved": true,
      "installed": true,
      "source": "clawhub",
      "author": "steipete",
      "pagePath": "steipete/github",
      "installedAt": "2026-04-21T00:00:00.000Z",
      "status": "healthy"
    }
  ]
}
```

Status values:

- `healthy`
- `missing_runtime`
- `orphaned_runtime`
- `pending_install`
- `pending_delete`

This gives the UI enough information to:

- render installed skills separately,
- disable install selection for already-installed skills,
- show the operator when a skill is healthy versus out of sync,
- show drift explicitly when the agent runtime and DB do not match,
- decide when delete should be allowed, including explicit deletion of orphaned runtime skills.

## Backend

### Runtime Delete Command

Assume the runtime removal command is `clawhub uninstall <slug>`.

The backend should still verify the outcome instead of trusting the command blindly:

1. Run `clawhub uninstall <slug>`.
2. Re-read `.clawhub/lock.json`.
3. Confirm the slug is absent.
4. Only then mutate `agents.clawhub_skills`.

This keeps the delete semantics aligned with install, where Nora verifies the lockfile before persisting state.

### Reconciliation Rules

Use the same rules in startup reconciliation, repair flows, and install/delete job handling:

- DB has skill, runtime has skill:
  No-op.
- DB has skill, runtime is missing skill:
  Install it into runtime.
- DB is missing skill, runtime has skill:
  Mark it as `orphaned_runtime` in the UI. The operator may explicitly delete it, and restart/provision reconciliation may also clean it up.
- DB is missing skill, runtime is missing skill:
  No-op.

That keeps the database as the deciding authority without making the ClawHub tab itself feel destructively surprising.

### Delete Worker Semantics

The delete worker should use a verify-before-persist flow:

1. Load and validate the agent.
2. Read current runtime skills from `.clawhub/lock.json`.
3. If the slug is already absent from runtime:
   Treat runtime deletion as already satisfied.
4. Otherwise run `clawhub uninstall <slug>`.
5. Re-read installed skills from `.clawhub/lock.json`.
6. If the slug is still present:
   Fail the job and keep the DB row unchanged.
7. Once runtime is confirmed clean:
   Remove the normalized entry from `agents.clawhub_skills` if one exists.

This means orphaned runtime skills can follow the normal delete path too. The only difference is that the final DB-removal step becomes a no-op because there is no saved entry to delete.

That ordering matches the intended normal case: runtime first, database second.

### API Contract

Keep the install shape and add matching delete primitives.

- `GET /api/clawhub/agents/:agentId/skills`
  Return merged DB/runtime state for each skill. This endpoint should return stable skill health data; temporary pending install/delete UI state can be overlaid by the frontend from job polling rather than embedded in the stable response.
- `POST /api/clawhub/agents/:agentId/skills/:slug/delete`
  Queue a delete job for a single skill and return the job handle.
- `GET /api/clawhub/jobs/:jobId`
  Reuse the existing polling endpoint, but include `operation: "install" | "delete"` once both job types exist. Job polling must remain user-scoped so a user can only read the status of ClawHub jobs tied to agents they own.

### Skill Identity

Do not assume bare `slug` is the only stable identifier Nora should preserve.

- Runtime operations and current ClawHub CLI flows are still slug-driven: `clawhub install <slug>`, `clawhub uninstall <slug>`.
- ClawHub also exposes canonical page URLs in `owner/slug` form and has explicitly added owner handles to search results so duplicate/common slugs are easier to disambiguate.

Product guidance:

- keep using `slug` for runtime install/uninstall commands,
- preserve `author` and `pagePath` in Nora's saved metadata and UI state,
- treat `author + slug` / canonical `pagePath` as the richer identity for display and saved-state matching when available.

### Queue / Worker Behavior

- Use a single BullMQ queue for all ClawHub mutations: `clawhub-jobs`.
- Each job carries `operation: "install" | "delete"`.
- Reject or coalesce duplicate in-flight jobs for the same `(agentId, slug, operation)`.
- Block conflicting install/delete jobs for the same `(agentId, slug)`.
- The shared queue is also the main serialization mechanism so multiple ClawHub jobs cannot race against the same lockfile.
- Reuse the existing install-worker patterns for runtime validation, logging, timeout handling, and post-job polling.

Jobs should serialize because they mutate shared runtime state for the same agent:

- the same workspace,
- the same `.clawhub/lock.json`,
- potentially the same skill directory.

Without serialization, install/delete jobs can race each other and leave the runtime or lockfile in an inconsistent state.

### Drift Handling

Because the DB is ground truth, the backend should manage drift deliberately rather than silently as a side effect of opening the UI.

- `missing_runtime`:
  Backend installs the skill into runtime during reconciliation.
- `orphaned_runtime`:
  Backend surfaces the drift in the UI, allows the operator to explicitly delete it, and may also remove it during restart/provision reconciliation rather than immediately on page load.

Recommended timing for repair:

- Automatic repair:
  Run drift reconciliation on restart/provision, where operators already expect state to be brought back in sync.
- Optional manual repair:
  A future `Sync ClawHub state` action in the UI could trigger the same reconciliation intentionally.

This avoids destructive surprises while still letting Nora converge the runtime back to the DB-owned state.

### Cleanup Scope

The first version of deletion should focus on the ClawHub install footprint only.

- Run `clawhub uninstall <slug>`.
- Remove the skill from the ClawHub-managed workspace/lockfile footprint.
- Do not attempt aggressive cleanup of arbitrary files a skill may have created outside that footprint.

If a skill writes side effects elsewhere, that is a harder cleanup problem and should be treated as out of scope for v1 unless the runtime offers stronger ownership metadata.

### Restart / Refresh Behavior

Use the same restart recommendation as installation and assume install/delete require a restart or session refresh for the change to fully take effect.

This matches the current ClawHub install UX in Nora, which already tells the user to restart the agent session after a successful install.

Product guidance for now:

- show a success state when the job completes,
- refresh the ClawHub tab data,
- show the same upper-right notification/toast pattern used by installation,
- prompt the operator to restart or reload the agent/session so the change is activated.

For background reconciliation:

- keep the repair itself in the background,
- show a completion notification when reconciliation installs or removes ClawHub skills.

## Open Questions

- Should restart messaging be a passive recommendation, or should the delete/install success UI more strongly direct the operator into a restart action?

## Suggested Implementation Order

1. Expand the installed-skills API into a merged DB/runtime state endpoint.
2. Add shared helpers for merged-state computation and `agents.clawhub_skills` mutation.
3. Implement delete queueing and the delete worker using `clawhub uninstall <slug>` plus lockfile verification.
4. Extend reconciliation so DB-only skills are installed and runtime-only skills are cleaned up at restart/provision boundaries.
5. Add delete mode to the current ClawHub tab components.
6. Add tests for mixed install/delete job states, drift reporting, and post-delete refresh behavior.

## Scope On This Branch

- Reuse the prior branch's OpenClaw tab shell update where it helps the deletion UX.
- Keep the plan explicit about frontend and backend contracts before implementing destructive behavior.
