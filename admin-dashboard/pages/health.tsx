import { useCallback, useEffect, useState } from "react";
import { Activity, CheckCircle2, AlertTriangle, XCircle, Loader2, RefreshCw } from "lucide-react";
import { clsx } from "clsx";
import AdminLayout from "../components/AdminLayout";
import { useToast } from "../components/Toast";
import { fetchWithAuth } from "../lib/api";
import { formatDateTime } from "../lib/format";

type CheckStatus = "ok" | "warn" | "fail";
type Check = { id: string; label: string; status: CheckStatus; detail?: string };
type Report = { generatedAt: string; overall: CheckStatus; checks: Check[] };

const STATUS_META: Record<
  CheckStatus,
  { label: string; icon: typeof CheckCircle2; badge: string; icon_color: string }
> = {
  ok: {
    label: "Healthy",
    icon: CheckCircle2,
    badge: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    icon_color: "text-emerald-500",
  },
  warn: {
    label: "Warning",
    icon: AlertTriangle,
    badge: "bg-orange-50 text-orange-700 ring-orange-200",
    icon_color: "text-orange-500",
  },
  fail: {
    label: "Failing",
    icon: XCircle,
    badge: "bg-red-50 text-red-700 ring-red-200",
    icon_color: "text-red-500",
  },
};

function HealthBadge({ status }: { status: CheckStatus }) {
  const meta = STATUS_META[status] || STATUS_META.fail;
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ring-1 ring-inset",
        meta.badge,
      )}
    >
      {meta.label}
    </span>
  );
}

export default function HealthPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();

  const load = useCallback(
    async (fresh = false) => {
      try {
        const res = await fetchWithAuth(`/api/admin/doctor${fresh ? "?fresh=1" : ""}`);
        if (res.ok) {
          setReport(await res.json());
        } else {
          toast.error("Failed to load health report");
        }
      } catch (error: any) {
        toast.error(error?.message || "Failed to load health report");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    load();
    const intervalId = setInterval(() => load(), 30000);
    return () => clearInterval(intervalId);
  }, [load]);

  const overall = report?.overall;
  const overallMeta = overall ? STATUS_META[overall] : null;
  const OverallIcon = overallMeta?.icon || Activity;

  return (
    <AdminLayout>
      <div className="flex flex-col gap-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-black tracking-tight text-slate-900">
              Control-plane health
            </h1>
            <p className="text-sm text-slate-500">
              Self-check of the Nora control plane. Also available from the CLI as{" "}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">nora doctor</code>.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              load(true);
            }}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Re-run
          </button>
        </header>

        {loading ? (
          <div className="flex justify-center p-20">
            <Loader2 className="animate-spin text-slate-400" />
          </div>
        ) : !report ? (
          <p className="text-sm text-slate-500">No report available.</p>
        ) : (
          <>
            <section
              className={clsx(
                "flex items-center gap-4 rounded-2xl border p-5",
                overall === "ok"
                  ? "border-emerald-200 bg-emerald-50"
                  : overall === "warn"
                    ? "border-orange-200 bg-orange-50"
                    : "border-red-200 bg-red-50",
              )}
            >
              <OverallIcon size={28} className={overallMeta?.icon_color} />
              <div className="flex flex-col">
                <span className="text-lg font-black text-slate-900">
                  {overall === "ok"
                    ? "All systems healthy"
                    : overall === "warn"
                      ? "Attention recommended"
                      : "Action required"}
                </span>
                <span className="text-xs text-slate-500">
                  Generated {formatDateTime(report.generatedAt)}
                </span>
              </div>
            </section>

            <ul className="flex flex-col gap-3">
              {report.checks.map((check) => {
                const meta = STATUS_META[check.status] || STATUS_META.fail;
                const Icon = meta.icon;
                return (
                  <li
                    key={check.id}
                    className="flex items-start gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                  >
                    <Icon size={20} className={clsx("mt-0.5 shrink-0", meta.icon_color)} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="text-sm font-bold text-slate-900">{check.label}</span>
                      <span className="text-sm text-slate-500">{check.detail}</span>
                    </div>
                    <HealthBadge status={check.status} />
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
