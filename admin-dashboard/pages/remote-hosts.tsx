import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Server } from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import StatusBadge from "../components/StatusBadge";
import { useToast } from "../components/Toast";
import { fetchWithAuth } from "../lib/api";
import { formatDateTime } from "../lib/format";

function sshTarget(host) {
  const user = host.sshUser ? `${host.sshUser}@` : "";
  const port = host.sshPort && host.sshPort !== 22 ? `:${host.sshPort}` : "";
  return `${user}${host.sshHost || "—"}${port}`;
}

function hostStatus(host) {
  if (!host.enabled) return "disabled";
  if (host.connected) return "active";
  if (!host.configured) return "warning";
  return "inactive";
}

export default function RemoteHostsPage() {
  const [hosts, setHosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  const loadHosts = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchWithAuth("/api/admin/remote-hosts");
      if (!response.ok) throw new Error("Failed to load remote hosts");
      const data = await response.json();
      setHosts(Array.isArray(data) ? data : []);
    } catch (error) {
      toast.error(error.message || "Failed to load remote hosts");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadHosts();
  }, [loadHosts]);

  const connectedCount = hosts.filter((host) => host.connected).length;

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-brand-cyan/15 p-2 text-brand-ink">
              <Server size={22} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Remote Hosts</h1>
              <p className="text-sm text-slate-500">
                Operator-registered remote machines across the fleet (read-only). Each host is owned
                and managed by its operator; credentials are never exposed here.
              </p>
            </div>
          </div>
          <button
            onClick={loadHosts}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {!loading && (
          <p className="text-sm text-slate-500">
            {hosts.length} host{hosts.length === 1 ? "" : "s"} · {connectedCount} connected
          </p>
        )}

        {loading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500">
            <Loader2 size={18} className="animate-spin" /> Loading remote hosts…
          </div>
        ) : hosts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            No operators have registered a remote host yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-semibold">Host</th>
                  <th className="px-4 py-3 font-semibold">Owner</th>
                  <th className="px-4 py-3 font-semibold">SSH target</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Last tested</th>
                </tr>
              </thead>
              <tbody>
                {hosts.map((host) => (
                  <tr key={host.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{host.label}</div>
                      <div className="font-mono text-xs text-slate-400">
                        {host.executionTargetId}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {host.ownerUserId || "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {sshTarget(host)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={hostStatus(host)} />
                      {host.lastTestStatus === "failed" && host.lastTestMessage ? (
                        <div
                          className="mt-1 max-w-xs truncate text-xs text-red-600"
                          title={host.lastTestMessage}
                        >
                          {host.lastTestMessage}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {host.lastTestedAt ? formatDateTime(host.lastTestedAt) : "Never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
