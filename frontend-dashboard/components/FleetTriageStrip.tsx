import { useEffect, useState } from "react";
import { AlertOctagon, AlertTriangle, ArrowUpRight } from "lucide-react";
import { fetchWithAuth } from "../lib/api";

type Reason = { code: string; severity: "error" | "warning"; label: string };
type AttentionAgent = {
  agentId: string;
  name: string | null;
  status: string | null;
  severity: "error" | "warning" | null;
  reasons: Reason[];
};
type FleetStatus = { attentionCount: number; agents: AttentionAgent[] };

// Surfaces the agents an operator should look at right now, derived server-side
// (errored, budget-paused, stuck deploying, approaching budget, stalled
// telemetry). Renders nothing until loaded, and stays hidden when all clear so
// it never adds noise to a healthy fleet.
export default function FleetTriageStrip() {
  const [data, setData] = useState<FleetStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth("/api/monitoring/fleet-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data || data.attentionCount === 0) return null;

  return (
    <section className="bg-white border border-amber-200 rounded-2xl sm:rounded-[2.5rem] p-5 sm:p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <AlertTriangle size={18} className="text-amber-600 shrink-0" />
        <h2 className="text-sm font-black text-slate-900 tracking-tight">
          Needs attention
          <span className="ml-2 text-amber-700">({data.attentionCount})</span>
        </h2>
      </div>
      <ul className="flex flex-col gap-2">
        {data.agents.map((agent) => {
          const isError = agent.severity === "error";
          const Icon = isError ? AlertOctagon : AlertTriangle;
          return (
            <li key={agent.agentId}>
              <a
                href={`/app/agents/${agent.agentId}`}
                className={`group flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${
                  isError
                    ? "bg-red-50 border-red-200 hover:bg-red-100"
                    : "bg-amber-50 border-amber-200 hover:bg-amber-100"
                }`}
              >
                <Icon
                  size={16}
                  className={`shrink-0 ${isError ? "text-red-600" : "text-amber-600"}`}
                />
                <span className="text-sm font-bold text-slate-900 truncate min-w-0">
                  {agent.name || agent.agentId}
                </span>
                <span className="flex flex-wrap gap-1.5 min-w-0">
                  {agent.reasons.map((reason) => (
                    <span
                      key={reason.code}
                      className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                        reason.severity === "error"
                          ? "bg-red-100 text-red-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {reason.label}
                    </span>
                  ))}
                </span>
                <ArrowUpRight
                  size={15}
                  className="ml-auto shrink-0 text-slate-400 group-hover:text-slate-600"
                />
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
