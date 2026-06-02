import { AlertTriangle, CheckCircle2, Trash2 } from "lucide-react";

export type AgentClawhubSkill = {
  slug: string;
  version: string;
  saved: boolean;
  installed: boolean;
  source: "clawhub";
  author: string;
  pagePath: string;
  installedAt: string | null;
  status: "healthy" | "missing_runtime" | "orphaned_runtime" | "pending_install" | "pending_delete";
};

type InstalledSkillsPanelProps = {
  skills: AgentClawhubSkill[];
  selectedDeleteSlugs?: Set<string>;
  deleting?: boolean;
  deleteError?: string | null;
  onToggleDelete: (skill: AgentClawhubSkill) => void;
  onDeleteSelected: () => void;
  onClearSelection?: () => void;
};

function statusPill(skill: AgentClawhubSkill) {
  switch (skill.status) {
    case "orphaned_runtime":
      return {
        label: "Orphaned",
        className: "bg-amber-100 text-amber-800",
        icon: AlertTriangle,
      };
    case "pending_delete":
      return {
        label: "Deleting",
        className: "bg-rose-100 text-rose-800",
        icon: Trash2,
      };
    case "pending_install":
      return {
        label: "Installing",
        className: "bg-blue-100 text-blue-800",
        icon: CheckCircle2,
      };
    default:
      return {
        label: "Installed",
        className: "bg-emerald-100 text-emerald-800",
        icon: CheckCircle2,
      };
  }
}

export default function InstalledSkillsPanel({
  skills,
  selectedDeleteSlugs = new Set(),
  deleting = false,
  deleteError = null,
  onToggleDelete,
  onDeleteSelected,
  onClearSelection,
}: InstalledSkillsPanelProps) {
  const selectedCount = selectedDeleteSlugs.size;

  if (!skills.length) {
    return (
      <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-5 py-8 text-center">
        <p className="text-sm font-bold text-slate-700">No ClawHub skills currently installed.</p>
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="space-y-3">
          <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">
            Installed Skills
          </div>
          <div className="flex items-center gap-2 text-2xl font-black text-slate-900">
            <CheckCircle2 size={20} className="text-emerald-500" />
            {skills.length} installed
          </div>
          <p className="text-sm text-slate-600">Select a skill to delete it from this agent.</p>
          {selectedCount ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-medium text-slate-500">
                {selectedCount} skill{selectedCount === 1 ? "" : "s"} selected for delete.
              </p>
              {onClearSelection ? (
                <button
                  type="button"
                  onClick={onClearSelection}
                  className="text-xs font-black text-slate-500 transition-colors hover:text-slate-700"
                >
                  Clear selection
                </button>
              ) : null}
            </div>
          ) : null}
          {deleteError ? <p className="text-sm font-medium text-red-600">{deleteError}</p> : null}
        </div>

        {selectedCount ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => onClearSelection?.()}
              className="inline-flex items-center justify-center gap-2 self-start rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-black text-slate-700 transition-colors hover:bg-slate-50"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={onDeleteSelected}
              disabled={deleting}
              className="inline-flex items-center justify-center gap-2 self-start rounded-2xl bg-rose-600 px-5 py-3 text-sm font-black text-white transition-colors hover:bg-rose-700 disabled:opacity-60"
            >
              <Trash2 size={16} />
              {deleting
                ? `Deleting ${selectedCount} skill${selectedCount === 1 ? "" : "s"}...`
                : `Delete Selected (${selectedCount})`}
            </button>
          </div>
        ) : null}
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        {skills.map((skill) => {
          const selectedForDelete = selectedDeleteSlugs.has(skill.slug);
          const pill = statusPill(skill);
          const StatusIcon = pill.icon;

          return (
            <button
              type="button"
              onClick={() => onToggleDelete(skill)}
              disabled={deleting || skill.status === "pending_delete"}
              key={`${skill.author}:${skill.slug}`}
              className={`inline-flex max-w-full items-center gap-2 rounded-2xl border px-3 py-2 text-left shadow-sm transition-all ${
                selectedForDelete
                  ? "border-rose-300 bg-rose-50/80"
                  : "border-slate-200 bg-slate-50 hover:border-slate-300"
              } disabled:opacity-60`}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate text-sm font-black text-slate-900">{skill.slug}</span>
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-[0.18em] ${pill.className}`}
                >
                  <StatusIcon size={10} />
                  {pill.label}
                </span>
                {skill.version ? (
                  <span className="text-xs font-semibold text-slate-500">v{skill.version}</span>
                ) : null}
              </div>
              <div className="truncate text-xs text-slate-500">
                {skill.pagePath || (skill.author ? `${skill.author}/${skill.slug}` : skill.slug)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
