import { useEffect, useState } from "react";
import { Loader2, Plug, ExternalLink, AlertTriangle } from "lucide-react";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../Toast";

type McpServer = {
  provider: string;
  name: string;
  npmPackage: string;
  docsUrl: string | null;
  notes: string | null;
  connected: boolean;
  enabled: boolean;
};

// Turns a connected integration into a Model Context Protocol server the agent's
// OpenClaw runtime spawns. Changing the set requires a redeploy to re-merge the
// runtime config, so we surface that explicitly after a change.
export default function McpServersSection({ agentId }: { agentId: string }) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth(`/api/agents/${agentId}/mcp-servers`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setServers(d?.servers || []);
      })
      .catch(() => {
        if (!cancelled) setServers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  async function toggle(provider: string, next: boolean) {
    if (!servers) return;
    const enabledProviders = servers
      .filter((s) => (s.provider === provider ? next : s.enabled))
      .map((s) => s.provider);
    setSaving(provider);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/mcp-servers`, {
        method: "PUT",
        body: JSON.stringify({ providers: enabledProviders }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Save failed");
      const data = await res.json();
      setServers(data.servers || []);
      setDirty(true);
    } catch (error: any) {
      toast.error(error?.message || "Failed to update MCP servers");
    } finally {
      setSaving(null);
    }
  }

  if (!servers) {
    return (
      <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <div className="flex items-center gap-2 text-slate-400">
          <Loader2 size={16} className="animate-spin" /> Loading MCP servers…
        </div>
      </section>
    );
  }

  return (
    <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
      <div className="flex items-center gap-2">
        <Plug size={16} className="text-blue-600" />
        <h3 className="text-sm font-bold text-slate-700">MCP Servers</h3>
      </div>
      <p className="text-xs text-slate-500 leading-relaxed">
        Expose a connected integration to this agent as a Model Context Protocol server. The runtime
        spawns each enabled server with the integration&apos;s own credentials.
      </p>

      {dirty ? (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <AlertTriangle size={14} className="text-amber-600 shrink-0" />
          <span className="text-xs font-semibold text-amber-800">
            Redeploy the agent to apply MCP server changes.
          </span>
        </div>
      ) : null}

      <ul className="divide-y divide-slate-100">
        {servers.map((server) => (
          <li key={server.provider} className="flex items-center gap-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-semibold text-slate-900">{server.name}</span>
              <span className="text-[11px] font-mono text-slate-400 truncate">
                {server.npmPackage}
              </span>
              {!server.connected ? (
                <span className="text-[11px] text-slate-400">
                  Connect the {server.name} integration above to enable.
                </span>
              ) : server.docsUrl ? (
                <a
                  href={server.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline w-fit"
                >
                  Server docs <ExternalLink size={11} />
                </a>
              ) : null}
            </div>
            {saving === server.provider ? (
              <Loader2 size={16} className="animate-spin text-slate-400" />
            ) : (
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={server.enabled}
                  disabled={!server.connected}
                  onChange={(e) => toggle(server.provider, e.target.checked)}
                />
                <div className="h-5 w-9 rounded-full bg-slate-200 peer-checked:bg-blue-600 peer-disabled:opacity-40 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:after:translate-x-4" />
              </label>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
