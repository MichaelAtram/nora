import { useCallback, useEffect, useState } from "react";
import { DollarSign, Loader2, Save, Trash2 } from "lucide-react";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../Toast";

const PERIOD_LABELS = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

// Per-agent LLM budget editor (Settings tab). One budget per period; when
// spend crosses 100% of a limit Nora pauses the runtime automatically.
export default function BudgetSection({ agentId }) {
  const [budgets, setBudgets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [period, setPeriod] = useState("monthly");
  const [limitUsd, setLimitUsd] = useState("");
  const [softPct, setSoftPct] = useState("80");
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/budget`);
      if (!res.ok) throw new Error("Failed to load budget");
      const data = await res.json();
      setBudgets(data.budgets || []);
    } catch {
      // Leave the editor usable even when the read fails.
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave(e) {
    e?.preventDefault();
    const limit = Number(limitUsd);
    if (!Number.isFinite(limit) || limit <= 0) {
      toast.error("Budget limit must be a positive amount");
      return;
    }
    setSaving(true);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/budget`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period,
          limit_usd: limit,
          soft_threshold_pct: Number(softPct) || 80,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to save budget");
      }
      toast.success("Budget saved");
      setLimitUsd("");
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(budget) {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/budget/${budget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to remove budget");
      toast.success("Budget removed");
      await load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-6">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-9 h-9 bg-emerald-50 rounded-xl flex items-center justify-center">
          <DollarSign size={16} className="text-emerald-600" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-gray-900">LLM budget caps</h3>
          <p className="text-xs text-gray-500">
            Nora pauses this agent automatically when spend crosses 100% of a cap. A warning event
            fires at the soft threshold.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-gray-500 py-4">
          <Loader2 size={14} className="animate-spin" /> Loading budget…
        </div>
      ) : (
        <>
          {budgets.length > 0 && (
            <div className="mt-4 space-y-2">
              {budgets.map((budget) => {
                const pct = Math.min(100, budget.pct || 0);
                const over = budget.bucket === "hard";
                const warn = budget.bucket === "soft";
                return (
                  <div
                    key={budget.id}
                    className="flex items-center gap-4 border border-gray-100 rounded-xl px-4 py-3"
                  >
                    <div className="flex-1">
                      <div className="flex items-center justify-between text-xs font-semibold text-gray-700">
                        <span>{PERIOD_LABELS[budget.period] || budget.period} cap</span>
                        <span className={over ? "text-red-600" : warn ? "text-amber-600" : ""}>
                          ${budget.currentUsd.toFixed(2)} / ${budget.limitUsd.toFixed(2)} (
                          {budget.pct}
                          %)
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${over ? "bg-red-500" : warn ? "bg-amber-400" : "bg-emerald-500"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <button
                      onClick={() => handleDelete(budget)}
                      className="text-gray-400 hover:text-red-600 transition-colors"
                      title="Remove budget"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <form onSubmit={handleSave} className="mt-4 flex flex-wrap items-end gap-3">
            <label className="text-xs font-semibold text-gray-600">
              Period
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="mt-1 block border border-gray-200 rounded-xl px-3 py-2 text-xs"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-gray-600">
              Hard cap (USD)
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={limitUsd}
                onChange={(e) => setLimitUsd(e.target.value)}
                placeholder="25.00"
                className="mt-1 block w-28 border border-gray-200 rounded-xl px-3 py-2 text-xs"
              />
            </label>
            <label className="text-xs font-semibold text-gray-600">
              Warn at (%)
              <input
                type="number"
                min="0"
                max="100"
                value={softPct}
                onChange={(e) => setSoftPct(e.target.value)}
                className="mt-1 block w-20 border border-gray-200 rounded-xl px-3 py-2 text-xs"
              />
            </label>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2.5 bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save cap
            </button>
          </form>
        </>
      )}
    </div>
  );
}
