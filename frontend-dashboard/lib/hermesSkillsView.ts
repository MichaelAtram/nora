// Pure display logic for the Hermes Skills panel. Kept out of the React
// component so it can be unit-tested with the repo's lightweight
// `tsx --test lib/*.test.ts` runner (there is no component-test harness).
//
// The Hermes skills API keys browse entries by registry ref (a
// slash-containing identifier like "official/security/1password") and
// installed rows by skill name, while the shared openclaw skill components
// (SkillCard/SkillGrid/InstalledSkillsPanel) key everything by `slug`. These
// helpers translate at that boundary so the shared components render Hermes
// data unmodified.

export type HermesSkillStatus =
  | "healthy"
  | "missing_runtime"
  | "orphaned_runtime"
  | "pending_install"
  | "pending_delete";

export type HermesSkillSummary = {
  ref: string;
  name?: string;
  description?: string;
  source?: string;
  trustLevel?: string;
  tags?: string[];
};

export type HermesBrowseCardSkill = {
  slug: string;
  name: string;
  description: string;
  downloads: null;
  stars: null;
  updatedAt: null;
};

export type HermesAgentSkillRow = {
  name: string;
  version?: string;
  saved?: boolean;
  installed?: boolean;
  source?: string;
  ref?: string;
  installMode?: string;
  installedAt?: string | null;
  status: HermesSkillStatus;
};

export type HermesInstalledCardRow = HermesAgentSkillRow & {
  slug: string;
  author: string;
  pagePath: string;
  version: string;
  installedAt: string | null;
};

export type HermesSkillJobStatus = {
  operation?: string;
  status?: string;
};

export type HermesLibraryEntry = {
  id?: string;
  ref: string;
  name?: string;
  description?: string;
};

// Map a registry browse summary onto the shared SkillCard shape. The Hermes
// index has no download/star counts or update timestamps: `null` (never 0)
// keeps SkillCard from rendering a stats row at all, because it only renders
// counts when `typeof value === "number"`. The description fallback lives
// here so SkillCard's ClawHub-branded fallback copy never shows.
export function browseSummaryToCardSkill(summary: HermesSkillSummary): HermesBrowseCardSkill {
  return {
    slug: summary.ref,
    name: summary.name || summary.ref,
    description: summary.description || "No description provided.",
    downloads: null,
    stars: null,
    updatedAt: null,
  };
}

// Map a merged agent skill row (name-keyed, ClawHub status vocabulary) onto
// the shared InstalledSkillsPanel row shape. The panel's subtitle renders
// `pagePath || slug`, so the registry ref becomes the subtitle when the entry
// has one and orphaned runtime installs (no ref) fall back to their name.
export function agentSkillRowToInstalledRow(row: HermesAgentSkillRow): HermesInstalledCardRow {
  return {
    ...row,
    slug: row.name,
    author: "",
    pagePath: row.ref || "",
    version: row.version || "",
    installedAt: row.installedAt || null,
  };
}

export function isJobActive(job?: HermesSkillJobStatus | null): boolean {
  return Boolean(job && (job.status === "pending" || job.status === "running"));
}

// Overlay in-flight job state (keyed by skill name) onto merged rows so the
// UI shows pending_install / pending_delete immediately instead of waiting
// for the next installed-state reload.
export function applyPendingJobOverlay(
  rows: HermesAgentSkillRow[],
  jobs: Record<string, HermesSkillJobStatus>,
): HermesAgentSkillRow[] {
  return rows.map((row) => {
    const job = jobs[row.name];
    if (!isJobActive(job)) return row;
    return {
      ...row,
      status: job?.operation === "delete" ? "pending_delete" : "pending_install",
    };
  });
}

// Names currently installed on the agent — the install identity, used to
// guard duplicate install requests.
export function computeInstalledNames(rows: HermesAgentSkillRow[]): Set<string> {
  return new Set(rows.filter((row) => row.installed).map((row) => row.name));
}

// Browse cards are keyed by registry ref, so the "Installed" badge needs the
// refs of installed rows. Orphaned runtime installs carry no ref and cannot
// be badged in the browse grid.
export function computeInstalledRefs(rows: HermesAgentSkillRow[]): Set<string> {
  return new Set(rows.filter((row) => row.installed && row.ref).map((row) => String(row.ref)));
}

// Library membership, keyed by registry ref (the library's unique key).
export function computeLibraryRefs(entries: HermesLibraryEntry[]): Set<string> {
  return new Set(entries.map((entry) => entry.ref).filter(Boolean));
}

// Rows shown in the installed section: mirrors ClawHubTab's filter — present
// on the runtime, orphaned there, or mid-delete. Saved-but-missing rows stay
// out of the installed panel (its status pills have no missing_runtime case).
export function installedSectionRows<T extends HermesAgentSkillRow>(rows: T[]): T[] {
  return rows.filter(
    (row) => row.installed || row.status === "orphaned_runtime" || row.status === "pending_delete",
  );
}

// Trust levels arrive as lowercase registry identifiers ("builtin",
// "trusted", "community"); capitalize for display.
export function formatHermesTrustLevel(value?: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
