import { useEffect, useMemo, useRef, useState } from "react";
import { BookMarked, Bot, Boxes, RefreshCw, Rocket, Trash2, X } from "lucide-react";
import { useToast } from "../../Toast";
import { fetchWithAuth } from "../../../lib/api";
import InstalledSkillsPanel from "../openclaw/InstalledSkillsPanel";
import SkillGrid from "../openclaw/SkillGrid";
import SkillSearchBar from "../openclaw/SkillSearchBar";
import SkillDetailCard from "./SkillDetailCard";
import {
  agentSkillRowToInstalledRow,
  applyPendingJobOverlay,
  browseSummaryToCardSkill,
  computeInstalledNames,
  computeInstalledRefs,
  computeLibraryRefs,
  installedSectionRows,
  isJobActive,
} from "../../../lib/hermesSkillsView";

const REGISTRY_UNAVAILABLE_MESSAGE =
  "Could not load skills. The Hermes skills registry may be unavailable.";

export default function HermesSkillsPanel({ agentId, agentStatus }) {
  const toast = useToast();
  const agentActive = agentStatus === "running" || agentStatus === "warning";
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedSkill, setSelectedSkill] = useState(null);
  const [selectedSkillDetail, setSelectedSkillDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [selectedInstallSkills, setSelectedInstallSkills] = useState([]);
  const [pendingInstallSelectionRefs, setPendingInstallSelectionRefs] = useState([]);
  const [selectedDeleteSkills, setSelectedDeleteSkills] = useState([]);
  const [selectionBusyRef, setSelectionBusyRef] = useState(null);
  const [jobStatuses, setJobStatuses] = useState<Record<string, any>>({});
  const [installError, setInstallError] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [agentSkills, setAgentSkills] = useState([]);
  const [library, setLibrary] = useState([]);
  const [libraryError, setLibraryError] = useState(null);
  const [libraryBusyId, setLibraryBusyId] = useState(null);
  const [libraryAddBusyRef, setLibraryAddBusyRef] = useState(null);
  const requestIdRef = useRef(0);
  const detailCacheRef = useRef({});

  const showingDefaultBrowseEmptyState = !query.trim() && !loading && !error && skills.length === 0;
  const browseCards = useMemo(() => skills.map(browseSummaryToCardSkill), [skills]);
  const displayedAgentSkills = useMemo(
    () => applyPendingJobOverlay(agentSkills, jobStatuses),
    [agentSkills, jobStatuses],
  );
  const installedSectionSkills = useMemo(
    () => installedSectionRows(displayedAgentSkills).map(agentSkillRowToInstalledRow),
    [displayedAgentSkills],
  );
  const installedNames = useMemo(() => computeInstalledNames(agentSkills), [agentSkills]);
  const installedRefs = useMemo(() => computeInstalledRefs(agentSkills), [agentSkills]);
  const libraryRefs = useMemo(() => computeLibraryRefs(library), [library]);
  const displayedSelectedInstallRefs = useMemo(
    () =>
      new Set([...pendingInstallSelectionRefs, ...selectedInstallSkills.map((skill) => skill.ref)]),
    [pendingInstallSelectionRefs, selectedInstallSkills],
  );
  const selectedDeleteNames = useMemo(
    () => new Set(selectedDeleteSkills.map((skill) => skill.slug)),
    [selectedDeleteSkills],
  );
  const activeInstallCount = useMemo(
    () =>
      Object.values(jobStatuses).filter(
        (status) => status.operation === "install" && isJobActive(status),
      ).length,
    [jobStatuses],
  );
  const activeDeleteCount = useMemo(
    () =>
      Object.values(jobStatuses).filter(
        (status) => status.operation === "delete" && isJobActive(status),
      ).length,
    [jobStatuses],
  );

  async function loadInstalledSkills() {
    try {
      const res = await fetchWithAuth(`/api/hermes-skills/agents/${agentId}/skills`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || "Could not load installed skills.");
      }
      setAgentSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (err) {
      console.error(err);
    }
  }

  async function loadLibrary() {
    setLibraryError(null);
    try {
      const res = await fetchWithAuth("/api/hermes-skills/library");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || "Could not load the skills library.");
      }
      setLibrary(Array.isArray(data.skills) ? data.skills : []);
    } catch (err) {
      setLibraryError(err?.message || "Could not load the skills library.");
    }
  }

  async function loadBrowseResults() {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const res = await fetchWithAuth("/api/hermes-skills/skills");
      const data = await res.json();
      if (requestId !== requestIdRef.current) return;

      if (!res.ok) {
        throw new Error(data.message || data.error || REGISTRY_UNAVAILABLE_MESSAGE);
      }

      setSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setSkills([]);
      setError(err?.message || REGISTRY_UNAVAILABLE_MESSAGE);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }

  async function searchSkills() {
    const trimmed = query.trim();
    if (!trimmed) {
      loadBrowseResults();
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const res = await fetchWithAuth(
        `/api/hermes-skills/skills/search?q=${encodeURIComponent(trimmed)}`,
      );
      const data = await res.json();
      if (requestId !== requestIdRef.current) return;

      if (!res.ok) {
        throw new Error(data.message || data.error || REGISTRY_UNAVAILABLE_MESSAGE);
      }

      setSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setSkills([]);
      setError(err?.message || REGISTRY_UNAVAILABLE_MESSAGE);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }

  async function fetchSkillDetail(ref) {
    const cached = detailCacheRef.current[ref];
    if (cached) {
      return cached;
    }

    const res = await fetchWithAuth(
      `/api/hermes-skills/skills/detail?ref=${encodeURIComponent(ref)}`,
    );
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.message || data.error || "Could not load skill details.");
    }

    detailCacheRef.current[ref] = data;
    return data;
  }

  // The grid hands back card objects keyed by slug; the slug IS the registry
  // ref for Hermes browse cards.
  async function loadSkillDetail(card) {
    setSelectedSkill({ ref: card.slug, name: card.name, description: card.description });
    setSelectedSkillDetail(detailCacheRef.current[card.slug] || null);
    setDetailError(null);
    setDetailLoading(true);

    try {
      const detail = await fetchSkillDetail(card.slug);
      setSelectedSkill(detail);
      setSelectedSkillDetail(detail);
    } catch (err) {
      setDetailError(err?.message || "Could not load skill details.");
    } finally {
      setDetailLoading(false);
    }
  }

  function addSelectedInstallSkill(detail) {
    setPendingInstallSelectionRefs((current) => current.filter((ref) => ref !== detail.ref));
    setSelectedInstallSkills((current) => {
      if (current.some((entry) => entry.ref === detail.ref)) return current;
      return [...current, detail];
    });
  }

  // Removal is matched on ref (browse identity) or name (install identity):
  // job completions only know the skill name.
  function removeSelectedInstallSkill(skill) {
    setPendingInstallSelectionRefs((current) => current.filter((ref) => ref !== skill.ref));
    setSelectedInstallSkills((current) =>
      current.filter((entry) => entry.ref !== skill.ref && entry.name !== skill.name),
    );
  }

  function clearSelectedInstallSkills() {
    setPendingInstallSelectionRefs([]);
    setSelectedInstallSkills([]);
  }

  function removeSelectedDeleteSkill(skill) {
    setSelectedDeleteSkills((current) => current.filter((entry) => entry.slug !== skill.slug));
  }

  function clearSelectedDeleteSkills() {
    setSelectedDeleteSkills([]);
  }

  function toggleInstalledSkillSelection(skill) {
    if (selectedDeleteNames.has(skill.slug)) {
      removeSelectedDeleteSkill(skill);
    } else {
      setSelectedDeleteSkills((current) => {
        if (current.some((entry) => entry.slug === skill.slug)) return current;
        return [...current, skill];
      });
    }
  }

  async function toggleSkillSelection(card) {
    const ref = card.slug;
    const cached = detailCacheRef.current[ref];
    if (displayedSelectedInstallRefs.has(ref)) {
      setPendingInstallSelectionRefs((current) => current.filter((entry) => entry !== ref));
      setSelectedInstallSkills((current) => current.filter((entry) => entry.ref !== ref));
      return;
    }

    setPendingInstallSelectionRefs((current) =>
      current.includes(ref) ? current : [...current, ref],
    );
    setSelectionBusyRef(ref);
    try {
      const detail = cached || (await fetchSkillDetail(ref));
      addSelectedInstallSkill(detail);
      setSelectedSkill(detail);
      setSelectedSkillDetail(detail);
      setDetailError(null);
    } catch (err) {
      setPendingInstallSelectionRefs((current) => current.filter((entry) => entry !== ref));
      toast.error(err?.message || "Could not update that selection.");
    } finally {
      setSelectionBusyRef(null);
    }
  }

  async function queueInstall(skill) {
    if (installedNames.has(skill.name)) {
      return;
    }
    const res = await fetchWithAuth(`/api/hermes-skills/agents/${agentId}/skills/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: skill.ref, name: skill.name }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || data.error || "Could not queue install.");
    }

    const name = data.name || skill.name;
    setJobStatuses((current) => ({
      ...current,
      [name]: {
        jobId: data.jobId,
        agentId: data.agentId,
        name,
        operation: "install",
        status: data.status || "pending",
        error: null,
        completedAt: null,
      },
    }));
  }

  async function handleInstallSelected() {
    const installable = selectedInstallSkills.filter((skill) => !installedNames.has(skill.name));
    if (!installable.length) {
      setInstallError("All selected skills are already installed.");
      return;
    }

    setInstallError(null);

    for (const skill of installable) {
      try {
        await queueInstall(skill);
      } catch (err) {
        setJobStatuses((current) => ({
          ...current,
          [skill.name]: {
            jobId: current[skill.name]?.jobId || `${skill.name}-failed`,
            agentId,
            name: skill.name,
            operation: "install",
            status: "failed",
            error: err?.message || "Could not queue install.",
            completedAt: null,
          },
        }));
      }
    }
  }

  async function handleDeleteSelected() {
    if (!selectedDeleteSkills.length) {
      setDeleteError("No installed skills selected for delete.");
      return;
    }

    setDeleteError(null);

    for (const skill of selectedDeleteSkills) {
      try {
        const res = await fetchWithAuth(`/api/hermes-skills/agents/${agentId}/skills/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: skill.slug }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || data.error || "Could not queue delete.");
        }

        setJobStatuses((current) => ({
          ...current,
          [data.name || skill.slug]: {
            jobId: data.jobId,
            agentId: data.agentId,
            name: data.name || skill.slug,
            operation: "delete",
            status: data.status || "pending",
            error: null,
            completedAt: null,
          },
        }));
      } catch (err) {
        setJobStatuses((current) => ({
          ...current,
          [skill.slug]: {
            jobId: current[skill.slug]?.jobId || `${skill.slug}-delete-failed`,
            agentId,
            name: skill.slug,
            operation: "delete",
            status: "failed",
            error: err?.message || "Could not queue delete.",
            completedAt: null,
          },
        }));
      }
    }
  }

  async function handleInstallLibraryEntry(entry) {
    try {
      await queueInstall(entry);
    } catch (err) {
      toast.error(err?.message || "Could not queue install.");
    }
  }

  async function handleAddToLibrary(skill) {
    if (!skill?.ref || libraryRefs.has(skill.ref)) return;
    setLibraryAddBusyRef(skill.ref);
    try {
      const res = await fetchWithAuth("/api/hermes-skills/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ref: skill.ref,
          name: skill.name || skill.ref,
          description: skill.description || "",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || "Could not add that skill to the library.");
      }
      toast.success(`${data.name || skill.name || skill.ref} added to the library.`);
      await loadLibrary();
    } catch (err) {
      toast.error(err?.message || "Could not add that skill to the library.");
    } finally {
      setLibraryAddBusyRef(null);
    }
  }

  async function handleRemoveLibraryEntry(entry) {
    setLibraryBusyId(entry.id);
    try {
      const res = await fetchWithAuth(
        `/api/hermes-skills/library/${encodeURIComponent(entry.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          data.message || data.error || "Could not remove that skill from the library.",
        );
      }
      setLibrary((current) => current.filter((row) => row.id !== entry.id));
    } catch (err) {
      toast.error(err?.message || "Could not remove that skill from the library.");
    } finally {
      setLibraryBusyId(null);
    }
  }

  function handleQueryChange(value) {
    setQuery(value);
    if (!value.trim()) {
      setSelectedSkill(null);
      setSelectedSkillDetail(null);
      setDetailError(null);
      loadBrowseResults();
    }
  }

  function handleClearSearch() {
    setQuery("");
    setSelectedSkill(null);
    setSelectedSkillDetail(null);
    setDetailError(null);
    loadBrowseResults();
  }

  useEffect(() => {
    if (!agentId || !agentActive) return;
    loadBrowseResults();
    loadLibrary();
  }, [agentId, agentActive]);

  useEffect(() => {
    if (!agentId || !agentActive) return;
    loadInstalledSkills();
  }, [agentId, agentActive]);

  useEffect(() => {
    const activeJobs = Object.values(jobStatuses).filter((status) => isJobActive(status));
    if (!activeJobs.length) return;

    const intervalId = window.setInterval(async () => {
      for (const job of activeJobs) {
        try {
          const res = await fetchWithAuth(
            `/api/hermes-skills/jobs/${encodeURIComponent(job.jobId)}`,
          );
          const data = await res.json();
          if (!res.ok) {
            continue;
          }

          setJobStatuses((current) => ({
            ...current,
            [data.name]: data,
          }));

          if (data.status === "success") {
            await loadInstalledSkills();
            if (data.operation === "install") {
              removeSelectedInstallSkill({ name: data.name });
              toast.success(`${data.name} installed.`);
            } else {
              removeSelectedDeleteSkill({ slug: data.name });
              toast.success(`${data.name} deleted.`);
            }
          }

          if (data.status === "failed" && data.error) {
            toast.error(data.error);
          }
        } catch (err) {
          console.error(err);
        }
      }
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [agentId, jobStatuses, toast]);

  if (!agentActive) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-12">
        <Bot size={32} className="text-slate-400" />
        <p className="text-sm font-medium text-slate-500">
          Hermes skills available when agent is{" "}
          <span className="font-bold text-green-500">running</span>
        </p>
        <p className="text-xs text-slate-400">
          Agent is currently <span className="font-bold">{agentStatus}</span>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-gradient-to-r from-white via-slate-50 to-blue-50 p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white px-3 py-1 text-[11px] font-black uppercase tracking-[0.18em] text-blue-700">
              <Boxes size={12} />
              Hermes Skills Hub
            </div>
            <h3 className="text-2xl font-black text-slate-900">Manage skills on this agent</h3>
            <p className="max-w-2xl text-sm leading-6 text-slate-600">
              Review installed Hermes skills, remove skills from the running agent, and browse the
              Hermes Skills Hub to queue new installs.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              loadBrowseResults();
              loadInstalledSkills();
              loadLibrary();
            }}
            disabled={loading}
            className="inline-flex items-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="space-y-3">
          <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">
            Skills Library
          </div>
          <div className="flex items-center gap-2 text-2xl font-black text-slate-900">
            <BookMarked size={20} className="text-blue-500" />
            {library.length} saved
          </div>
          <p className="text-sm text-slate-600">
            Skills curated for this Nora instance. Install one on this agent, or remove it from the
            shared library.
          </p>
          {libraryError ? <p className="text-sm font-medium text-red-600">{libraryError}</p> : null}
        </div>

        {library.length ? (
          <div className="mt-5 grid grid-cols-1 gap-3 xl:grid-cols-2">
            {library.map((entry) => {
              const installed = installedNames.has(entry.name);
              const busy = isJobActive(jobStatuses[entry.name]);
              return (
                <div
                  key={entry.id}
                  className="flex h-full flex-col justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-black text-slate-900">{entry.name}</div>
                    <div className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {entry.ref}
                    </div>
                    {entry.description ? (
                      <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">
                        {entry.description}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleInstallLibraryEntry(entry)}
                      disabled={installed || busy}
                      className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-black text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
                    >
                      <Rocket size={12} />
                      {installed ? "Installed" : busy ? "Working..." : "Install"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveLibraryEntry(entry)}
                      disabled={libraryBusyId === entry.id}
                      className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-600 transition-colors hover:bg-slate-100 hover:text-rose-700 disabled:opacity-60"
                    >
                      <Trash2 size={12} />
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-6 text-center">
            <p className="text-sm font-bold text-slate-700">No skills in the library yet.</p>
            <p className="mt-1 text-xs text-slate-500">
              Open a skill below and choose &quot;Add to library&quot; to pin it for every operator
              on this instance.
            </p>
          </div>
        )}
      </div>

      <div className="space-y-3">
        {installedSectionSkills.length ? (
          // Hermes rows satisfy everything the shared panel renders (slug,
          // status, version, pagePath); the AgentClawhubSkill type's
          // clawhub-literal `source` field is the only mismatch, so the cast
          // stays contained to this boundary.
          <InstalledSkillsPanel
            skills={installedSectionSkills as any}
            selectedDeleteSlugs={selectedDeleteNames}
            deleting={activeDeleteCount > 0}
            deleteError={deleteError}
            onToggleDelete={toggleInstalledSkillSelection}
            onDeleteSelected={handleDeleteSelected}
            onClearSelection={clearSelectedDeleteSkills}
          />
        ) : (
          // The shared panel's empty state is ClawHub-branded, so the Hermes
          // panel renders its own copy of the same empty-state block.
          <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-5 py-8 text-center">
            <p className="text-sm font-bold text-slate-700">
              No Hermes skills currently installed.
            </p>
          </div>
        )}
      </div>

      <SkillSearchBar
        placeholder="Search Hermes skills and press Enter"
        query={query}
        loading={loading}
        onQueryChange={handleQueryChange}
        onSubmit={searchSkills}
        onClear={handleClearSearch}
      />

      {selectedInstallSkills.length ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-2">
              <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">
                Selected Skills
              </div>
              <p className="text-sm font-semibold text-slate-900">
                {selectedInstallSkills.length} skill{selectedInstallSkills.length === 1 ? "" : "s"}{" "}
                selected for install.
              </p>
              <div className="flex flex-wrap gap-2">
                {selectedInstallSkills.map((skill) => (
                  <span
                    key={skill.ref}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-bold text-slate-800"
                  >
                    {skill.name || skill.ref}
                    <button
                      type="button"
                      onClick={() => removeSelectedInstallSkill(skill)}
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-800"
                      aria-label={`Remove ${skill.name || skill.ref} from install selection`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
              {installError ? (
                <p className="text-sm font-medium text-red-600">{installError}</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={clearSelectedInstallSkills}
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 transition-colors hover:bg-slate-50"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={handleInstallSelected}
                disabled={activeInstallCount > 0}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-5 py-3 text-sm font-black text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
              >
                <Rocket size={16} />
                {activeInstallCount
                  ? `Installing ${activeInstallCount} skill${activeInstallCount === 1 ? "" : "s"}...`
                  : `Install Selected (${selectedInstallSkills.length})`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.9fr)]">
        <div className="min-w-0">
          <SkillGrid
            loadingLabel="Loading Hermes skills..."
            skills={browseCards}
            loading={loading}
            error={error}
            query={query}
            selectedSlug={null}
            installedSlugs={installedRefs}
            selectedSkillSlugs={displayedSelectedInstallRefs}
            selectionBusySlug={selectionBusyRef}
            onSelect={loadSkillDetail}
            onToggleSelection={toggleSkillSelection}
            emptyTitle={
              showingDefaultBrowseEmptyState
                ? "Search the Hermes Skills Hub to discover skills."
                : "No skills found."
            }
            emptyMessage={
              showingDefaultBrowseEmptyState
                ? "The registry returned an empty default browse list. Enter a search and press Enter to find skills."
                : undefined
            }
          />
        </div>

        <div className="min-w-0">
          <SkillDetailCard
            skill={selectedSkill}
            detail={selectedSkillDetail}
            loading={detailLoading}
            error={detailError}
            inLibrary={selectedSkill ? libraryRefs.has(selectedSkill.ref) : false}
            libraryBusy={selectedSkill ? libraryAddBusyRef === selectedSkill.ref : false}
            onAddToLibrary={handleAddToLibrary}
            onClose={() => {
              setSelectedSkill(null);
              setSelectedSkillDetail(null);
              setDetailError(null);
              setDetailLoading(false);
            }}
          />
        </div>
      </div>
    </div>
  );
}
