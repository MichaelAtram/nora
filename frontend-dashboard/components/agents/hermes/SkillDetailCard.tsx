import { BookMarked, ChevronLeft, CircleAlert, FileText } from "lucide-react";
import { formatHermesTrustLevel } from "../../../lib/hermesSkillsView";

function MetaChip({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 break-all text-xs font-medium text-slate-700">{value || "Not listed"}</p>
    </div>
  );
}

// Local stand-in for the shared openclaw SkillDetailPanel: Hermes index
// entries carry no readme, download counts, or requirements metadata, so the
// ClawHub-shaped panel would render misleading zero-count and empty-README
// sections. This card shows the metadata the Hermes registry actually
// provides (source, trust level, repo/path, tags) plus the library action.
export default function SkillDetailCard({
  skill,
  detail,
  loading,
  error,
  inLibrary,
  libraryBusy,
  onAddToLibrary,
  onClose,
}) {
  const activeSkill = detail || skill;

  return (
    <aside className="lg:sticky lg:top-5">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-sky-600">
              Skill Detail
            </p>
            <h4 className="mt-1 text-lg font-black text-slate-900">
              {activeSkill?.name || "Select a skill to inspect"}
            </h4>
          </div>
          {activeSkill ? (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-600 transition hover:bg-slate-100"
            >
              <ChevronLeft size={12} />
              Close
            </button>
          ) : null}
        </div>

        {!activeSkill ? (
          <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
            <FileText size={24} className="mx-auto text-slate-300" />
            <p className="mt-3 text-sm font-bold text-slate-700">
              Pick a card to see the skill&apos;s registry metadata.
            </p>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              This panel is read-only and focused on the skill&apos;s details.
            </p>
          </div>
        ) : (
          <div className="mt-5 space-y-5">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-600">
                  {activeSkill.ref}
                </span>
              </div>
              <p className="text-sm leading-6 text-slate-600">
                {activeSkill.description || "No description provided."}
              </p>
            </div>

            {error ? (
              <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                <div className="flex items-start gap-2">
                  <CircleAlert size={16} className="mt-0.5 shrink-0 text-red-500" />
                  <div>
                    <p className="font-bold text-red-800">Could not load skill details.</p>
                    <p className="mt-1 text-xs leading-5 text-red-700">{error}</p>
                  </div>
                </div>
              </div>
            ) : null}

            {loading && !detail ? (
              <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="h-4 w-1/2 animate-pulse rounded-full bg-slate-200" />
                <div className="h-4 w-full animate-pulse rounded-full bg-slate-200" />
                <div className="h-4 w-3/4 animate-pulse rounded-full bg-slate-200" />
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <MetaChip label="Source" value={activeSkill.source} />
                <MetaChip
                  label="Trust level"
                  value={formatHermesTrustLevel(activeSkill.trustLevel)}
                />
                <MetaChip label="Repository" value={detail?.repo} />
                <MetaChip label="Path" value={detail?.path} />
              </div>
            )}

            {detail?.tags?.length ? (
              <div className="flex flex-wrap gap-2">
                {detail.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => onAddToLibrary(activeSkill)}
              disabled={inLibrary || libraryBusy}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
            >
              <BookMarked size={14} />
              {inLibrary ? "In library" : libraryBusy ? "Adding..." : "Add to library"}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
