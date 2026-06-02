import { useEffect, useMemo, useRef, useState } from "react";
import { Boxes, RefreshCw, Rocket, X } from "lucide-react";
import { useToast } from "../../Toast";
import { fetchWithAuth } from "../../../lib/api";
import SkillDetailPanel, { SkillDetail } from "./SkillDetailPanel";
import SkillGrid from "./SkillGrid";
import InstalledSkillsPanel, { AgentClawhubSkill } from "./InstalledSkillsPanel";
import SkillSearchBar from "./SkillSearchBar";
import { SkillSummary } from "./SkillCard";

type ClawHubTabProps = {
  agentId: string;
  refreshToken?: string | null;
  onInstallSuccess?: () => void;
};

type SkillListResponse = {
  skills?: SkillSummary[];
  cursor?: string | null;
  error?: string;
  message?: string;
};

type InstalledSkillsResponse = {
  skills?: AgentClawhubSkill[];
  error?: string;
  message?: string;
};

type ClawhubJobResponse = {
  jobId: string;
  agentId: string;
  slug: string;
  operation: "install" | "delete";
  status: "pending" | "running" | "success" | "failed";
};

type ClawhubJobStatus = {
  jobId: string;
  agentId: string;
  slug: string;
  operation: "install" | "delete";
  status: "pending" | "running" | "success" | "failed";
  error: string | null;
  completedAt: string | null;
};

export default function ClawHubTab({ agentId, refreshToken, onInstallSuccess }: ClawHubTabProps) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const [selectedSkillDetail, setSelectedSkillDetail] = useState<SkillDetail | null>(null);
  const [selectedSkillContext, setSelectedSkillContext] = useState<"catalog" | "installed">(
    "catalog",
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedInstallSkills, setSelectedInstallSkills] = useState<SkillDetail[]>([]);
  const [pendingInstallSelectionSlugs, setPendingInstallSelectionSlugs] = useState<string[]>([]);
  const [selectedDeleteSkills, setSelectedDeleteSkills] = useState<AgentClawhubSkill[]>([]);
  const [selectionBusySlug, setSelectionBusySlug] = useState<string | null>(null);
  const [installBusySlug, setInstallBusySlug] = useState<string | null>(null);
  const [deleteBusySlug, setDeleteBusySlug] = useState<string | null>(null);
  const [jobStatuses, setJobStatuses] = useState<Record<string, ClawhubJobStatus>>({});
  const [installError, setInstallError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [agentSkills, setAgentSkills] = useState<AgentClawhubSkill[]>([]);
  const requestIdRef = useRef(0);
  const detailCacheRef = useRef<Record<string, SkillDetail>>({});

  const showingDefaultBrowseEmptyState = !query.trim() && !loading && !error && skills.length === 0;
  const displayedAgentSkills = useMemo(
    () =>
      agentSkills.map((skill) => {
        const pending = jobStatuses[skill.slug];
        if (!pending || (pending.status !== "pending" && pending.status !== "running")) {
          return skill;
        }
        if (pending.operation === "delete") {
          return {
            ...skill,
            status: "pending_delete" as const,
          };
        }
        return {
          ...skill,
          status: "pending_install" as const,
        };
      }),
    [agentSkills, jobStatuses],
  );
  const installedSlugs = useMemo(
    () => new Set(agentSkills.filter((skill) => skill.installed).map((skill) => skill.slug)),
    [agentSkills],
  );
  const selectedInstallSlugs = useMemo(
    () => new Set(selectedInstallSkills.map((skill) => skill.slug)),
    [selectedInstallSkills],
  );
  const displayedSelectedInstallSlugs = useMemo(
    () =>
      new Set([
        ...pendingInstallSelectionSlugs,
        ...selectedInstallSkills.map((skill) => skill.slug),
      ]),
    [pendingInstallSelectionSlugs, selectedInstallSkills],
  );
  const selectedDeleteSlugs = useMemo(
    () => new Set(selectedDeleteSkills.map((skill) => skill.slug)),
    [selectedDeleteSkills],
  );
  const selectedCatalogSkill = selectedSkillDetail
    ? selectedInstallSlugs.has(selectedSkillDetail.slug)
    : false;
  const activeInstallCount = useMemo(
    () =>
      Object.values(jobStatuses).filter(
        (status) =>
          status.operation === "install" &&
          (status.status === "pending" || status.status === "running"),
      ).length,
    [jobStatuses],
  );
  const activeDeleteCount = useMemo(
    () =>
      Object.values(jobStatuses).filter(
        (status) =>
          status.operation === "delete" &&
          (status.status === "pending" || status.status === "running"),
      ).length,
    [jobStatuses],
  );
  const installedSectionSkills = useMemo(
    () =>
      displayedAgentSkills.filter(
        (skill) =>
          skill.installed ||
          skill.status === "orphaned_runtime" ||
          skill.status === "pending_delete",
      ),
    [displayedAgentSkills],
  );

  async function loadInstalledSkills() {
    try {
      const res = await fetchWithAuth(`/api/clawhub/agents/${agentId}/skills`);
      const data: InstalledSkillsResponse = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || "Could not load installed skills.");
      }
      setAgentSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (err: any) {
      console.error(err);
    }
  }

  async function loadBrowseResults() {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const res = await fetchWithAuth("/api/clawhub/skills");
      const data: SkillListResponse = await res.json();
      if (requestId !== requestIdRef.current) return;

      if (!res.ok) {
        throw new Error(
          data.message || data.error || "Could not load skills. ClawHub may be unavailable.",
        );
      }

      setSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      setSkills([]);
      setError(err?.message || "Could not load skills. ClawHub may be unavailable.");
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
        `/api/clawhub/skills/search?q=${encodeURIComponent(trimmed)}`,
      );
      const data: SkillListResponse = await res.json();
      if (requestId !== requestIdRef.current) return;

      if (!res.ok) {
        throw new Error(
          data.message || data.error || "Could not load skills. ClawHub may be unavailable.",
        );
      }

      setSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      setSkills([]);
      setError(err?.message || "Could not load skills. ClawHub may be unavailable.");
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }

  async function fetchSkillDetail(skill: SkillSummary) {
    const cached = detailCacheRef.current[skill.slug];
    if (cached) {
      return cached;
    }

    const res = await fetchWithAuth(`/api/clawhub/skills/${encodeURIComponent(skill.slug)}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.message || data.error || "Could not load skill details.");
    }

    detailCacheRef.current[skill.slug] = data;
    return data as SkillDetail;
  }

  async function loadSkillDetail(
    skill: SkillSummary,
    context: "catalog" | "installed" = "catalog",
  ) {
    setSelectedSkillContext(context);
    setSelectedSkill(skill);
    setSelectedSkillDetail(detailCacheRef.current[skill.slug] || null);
    setDetailError(null);
    setDetailLoading(true);

    try {
      const detail = await fetchSkillDetail(skill);
      setSelectedSkill({
        slug: detail.slug,
        name: detail.name,
        description: detail.description,
        downloads: detail.downloads,
        stars: detail.stars,
        updatedAt: detail.updatedAt || null,
      });
      setSkills((current) =>
        current.map((entry) =>
          entry.slug === detail.slug
            ? {
                ...entry,
                name: detail.name,
                description: detail.description,
                downloads: detail.downloads,
                stars: detail.stars,
                updatedAt: detail.updatedAt || entry.updatedAt,
              }
            : entry,
        ),
      );
      setSelectedSkillDetail(detail);
    } catch (err: any) {
      setDetailError(err?.message || "Could not load skill details.");
    } finally {
      setDetailLoading(false);
    }
  }

  function toggleInstalledSkillSelection(skill: AgentClawhubSkill) {
    toggleDeleteSelection(skill);
  }

  function addSelectedInstallSkill(skill: SkillDetail) {
    setPendingInstallSelectionSlugs((current) => current.filter((slug) => slug !== skill.slug));
    setSelectedInstallSkills((current) => {
      if (current.some((entry) => entry.slug === skill.slug)) return current;
      return [...current, skill];
    });
  }

  function removeSelectedInstallSkill(skill: Pick<SkillDetail, "slug">) {
    setPendingInstallSelectionSlugs((current) => current.filter((slug) => slug !== skill.slug));
    setSelectedInstallSkills((current) => current.filter((entry) => entry.slug !== skill.slug));
  }

  function clearSelectedInstallSkills() {
    setPendingInstallSelectionSlugs([]);
    setSelectedInstallSkills([]);
  }

  function addSelectedDeleteSkill(skill: AgentClawhubSkill) {
    setSelectedDeleteSkills((current) => {
      if (current.some((entry) => entry.slug === skill.slug)) return current;
      return [...current, skill];
    });
  }

  function removeSelectedDeleteSkill(skill: Pick<AgentClawhubSkill, "slug">) {
    setSelectedDeleteSkills((current) => current.filter((entry) => entry.slug !== skill.slug));
  }

  function clearSelectedDeleteSkills() {
    setSelectedDeleteSkills([]);
  }

  function toggleDeleteSelection(skill: AgentClawhubSkill) {
    setDeleteBusySlug(skill.slug);
    try {
      if (selectedDeleteSlugs.has(skill.slug)) {
        removeSelectedDeleteSkill(skill);
      } else {
        addSelectedDeleteSkill(skill);
      }
    } finally {
      setDeleteBusySlug(null);
    }
  }

  async function toggleSkillSelection(skill: SkillSummary) {
    const cached = detailCacheRef.current[skill.slug];
    if (displayedSelectedInstallSlugs.has(skill.slug)) {
      setPendingInstallSelectionSlugs((current) => current.filter((slug) => slug !== skill.slug));
      if (cached) {
        removeSelectedInstallSkill(cached);
      } else {
        setSelectedInstallSkills((current) => current.filter((entry) => entry.slug !== skill.slug));
      }
      return;
    }

    setPendingInstallSelectionSlugs((current) =>
      current.includes(skill.slug) ? current : [...current, skill.slug],
    );
    setSelectionBusySlug(skill.slug);
    try {
      const detail = cached || (await fetchSkillDetail(skill));
      if (!selectedInstallSlugs.has(detail.slug)) {
        addSelectedInstallSkill(detail);
      }
      setSelectedSkillContext("catalog");
      setSelectedSkill({
        slug: detail.slug,
        name: detail.name,
        description: detail.description,
        downloads: detail.downloads,
        stars: detail.stars,
        updatedAt: detail.updatedAt || null,
      });
      setSelectedSkillDetail(detail);
      setDetailError(null);
    } catch (err: any) {
      setPendingInstallSelectionSlugs((current) => current.filter((slug) => slug !== skill.slug));
      toast.error(err?.message || "Could not update that selection.");
    } finally {
      setSelectionBusySlug(null);
    }
  }

  async function queueInstall(detail: SkillDetail) {
    if (installedSlugs.has(detail.slug)) {
      return;
    }
    const res = await fetchWithAuth(
      `/api/clawhub/agents/${agentId}/skills/${encodeURIComponent(detail.slug)}/install`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "clawhub",
          author: detail.author || "",
          pagePath:
            detail.pagePath || (detail.author ? `${detail.author}/${detail.slug}` : detail.slug),
          installedAt: detail.installedAt || new Date().toISOString(),
        }),
      },
    );
    const data: ClawhubJobResponse & { error?: string; message?: string } = await res.json();
    if (!res.ok) {
      throw new Error(data.message || data.error || "Could not queue install.");
    }

    setJobStatuses((current) => ({
      ...current,
      [detail.slug]: {
        jobId: data.jobId,
        agentId: data.agentId,
        slug: data.slug,
        operation: "install",
        status: data.status,
        error: null,
        completedAt: null,
      },
    }));
  }

  async function handleInstallSelected() {
    const installable = selectedInstallSkills.filter((skill) => !installedSlugs.has(skill.slug));
    if (!installable.length) {
      setInstallError("All selected skills are already installed.");
      return;
    }

    setInstallError(null);

    for (const skill of installable) {
      setInstallBusySlug(skill.slug);
      try {
        await queueInstall(skill);
      } catch (err: any) {
        setJobStatuses((current) => ({
          ...current,
          [skill.slug]: {
            jobId: current[skill.slug]?.jobId || `${skill.slug}-failed`,
            agentId,
            slug: skill.slug,
            operation: "install",
            status: "failed",
            error: err?.message || "Could not queue install.",
            completedAt: null,
          },
        }));
      } finally {
        setInstallBusySlug(null);
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
        const res = await fetchWithAuth(
          `/api/clawhub/agents/${agentId}/skills/${encodeURIComponent(skill.slug)}/delete`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              source: "clawhub",
              author: skill.author,
              pagePath: skill.pagePath,
              installedAt: skill.installedAt,
            }),
          },
        );
        const data: ClawhubJobResponse & { error?: string; message?: string } = await res.json();
        if (!res.ok) {
          throw new Error(data.message || data.error || "Could not queue delete.");
        }

        setJobStatuses((current) => ({
          ...current,
          [skill.slug]: {
            jobId: data.jobId,
            agentId: data.agentId,
            slug: data.slug,
            operation: "delete",
            status: data.status,
            error: null,
            completedAt: null,
          },
        }));
      } catch (err: any) {
        setJobStatuses((current) => ({
          ...current,
          [skill.slug]: {
            jobId: current[skill.slug]?.jobId || `${skill.slug}-delete-failed`,
            agentId,
            slug: skill.slug,
            operation: "delete",
            status: "failed",
            error: err?.message || "Could not queue delete.",
            completedAt: null,
          },
        }));
      }
    }
  }

  function handleQueryChange(value: string) {
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
    loadBrowseResults();
  }, [agentId]);

  useEffect(() => {
    loadInstalledSkills();
  }, [agentId, refreshToken]);

  useEffect(() => {
    const activeJobs = Object.values(jobStatuses).filter(
      (status) => status.status === "pending" || status.status === "running",
    );
    if (!activeJobs.length) return;

    const intervalId = window.setInterval(async () => {
      for (const job of activeJobs) {
        try {
          const res = await fetchWithAuth(`/api/clawhub/jobs/${encodeURIComponent(job.jobId)}`);
          const data: ClawhubJobStatus & { error?: string } = await res.json();
          if (!res.ok) {
            continue;
          }

          setJobStatuses((current) => ({
            ...current,
            [data.slug]: data,
          }));

          if (data.status === "success") {
            await loadInstalledSkills();
            if (data.operation === "install") {
              removeSelectedInstallSkill({ slug: data.slug });
              toast.success(`${data.slug} installed. Restart your agent session to activate it.`);
              onInstallSuccess?.();
            } else {
              removeSelectedDeleteSkill({ slug: data.slug });
              toast.success(
                `${data.slug} deleted. Restart your agent session to apply the removal.`,
              );
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
  }, [agentId, jobStatuses, onInstallSuccess, toast]);

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-gradient-to-r from-white via-slate-50 to-blue-50 p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white px-3 py-1 text-[11px] font-black uppercase tracking-[0.18em] text-blue-700">
              <Boxes size={12} />
              ClawHub Catalog
            </div>
            <h3 className="text-2xl font-black text-slate-900">Manage skills on this agent</h3>
            <p className="max-w-2xl text-sm leading-6 text-slate-600">
              Review installed ClawHub skills, remove skills from the running agent, and browse the
              public registry to queue new installs.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              loadBrowseResults();
              loadInstalledSkills();
            }}
            disabled={loading}
            className="inline-flex items-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <InstalledSkillsPanel
          skills={installedSectionSkills}
          selectedDeleteSlugs={selectedDeleteSlugs}
          deleting={activeDeleteCount > 0}
          deleteError={deleteError}
          onToggleDelete={toggleInstalledSkillSelection}
          onDeleteSelected={handleDeleteSelected}
          onClearSelection={clearSelectedDeleteSkills}
        />
      </div>

      <SkillSearchBar
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
                    key={skill.slug}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-bold text-slate-800"
                  >
                    {skill.name || skill.slug}
                    <button
                      type="button"
                      onClick={() => removeSelectedInstallSkill(skill)}
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-800"
                      aria-label={`Remove ${skill.name || skill.slug} from install selection`}
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
            skills={skills}
            loading={loading}
            error={error}
            query={query}
            selectedSlug={null}
            installedSlugs={installedSlugs}
            selectedSkillSlugs={displayedSelectedInstallSlugs}
            selectionBusySlug={selectionBusySlug}
            onSelect={loadSkillDetail}
            onToggleSelection={toggleSkillSelection}
            emptyTitle={
              showingDefaultBrowseEmptyState
                ? "Search ClawHub to discover skills."
                : "No skills found."
            }
            emptyMessage={
              showingDefaultBrowseEmptyState
                ? "ClawHub is returning an empty default browse list right now. Enter a search and press Enter to find skills."
                : undefined
            }
          />
        </div>

        <div className="min-w-0">
          <SkillDetailPanel
            skill={selectedSkill}
            detail={selectedSkillDetail}
            loading={detailLoading}
            error={detailError}
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
