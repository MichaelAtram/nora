import { useState, useEffect } from "react";
import { Puzzle, Search, Loader2 } from "lucide-react";
import IntegrationCard from "./IntegrationCard";
import ActiveIntegrationsPanel from "./ActiveIntegrationsPanel";
import IntegrationDetailPanel from "./IntegrationDetailPanel";
import McpServersSection from "./McpServersSection";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../Toast";
import { emitAgentDataChanged, subscribeToAgentDataChanged } from "./agentEvents";

const categories = [
  { id: "all", label: "All" },
  { id: "developer-tools", label: "Developer Tools" },
  { id: "communication", label: "Communication" },
  { id: "ai-ml", label: "AI / ML" },
  { id: "cloud", label: "Cloud" },
  { id: "data", label: "Data" },
  { id: "monitoring", label: "Monitoring" },
  { id: "productivity", label: "Productivity" },
  { id: "crm", label: "CRM" },
  { id: "storage", label: "Storage" },
  { id: "payment", label: "Payment" },
  { id: "social", label: "Social" },
  { id: "analytics", label: "Analytics" },
  { id: "search", label: "Search" },
  { id: "devops", label: "DevOps" },
  { id: "automation", label: "Automation" },
  { id: "ecommerce", label: "E-Commerce" },
];

export default function IntegrationsTab({ agentId }) {
  const [catalog, setCatalog] = useState([]);
  const [installed, setInstalled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string | null>(null);
  const [savingIntegration, setSavingIntegration] = useState(false);
  const toast = useToast();

  useEffect(() => {
    loadData();
  }, [agentId]);

  useEffect(() => {
    return subscribeToAgentDataChanged(agentId, () => {
      loadData();
    });
  }, [agentId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const integration = url.searchParams.get("integration");
    const status = url.searchParams.get("status");
    const error = url.searchParams.get("error");
    if (!integration || !status) return;

    if (integration === "twitter") {
      if (status === "connected") {
        toast.success("Twitter/X connected");
        loadData();
      } else if (status === "error") {
        toast.error(error || `${integration} connection failed`);
      }
      url.searchParams.delete("integration");
      url.searchParams.delete("status");
      url.searchParams.delete("error");
      window.history.replaceState({}, "", `${url.pathname}${url.search}`);
    }
  }, [toast]);

  async function runIntegrationTest(integration, { silentSuccess = false } = {}) {
    try {
      const res = await fetchWithAuth(
        `/api/agents/${agentId}/integrations/${integration.id}/test`,
        {
          method: "POST",
        },
      );
      const result = await res.json();
      if (result.success) {
        if (!silentSuccess) {
          toast.success(result.message || "Connection verified");
        }
      } else {
        toast.error(result.error || result.message || "Test failed");
      }
      await loadData();
      emitAgentDataChanged({ agentId, scope: "integrations" });
      return result;
    } catch {
      toast.error("Test request failed");
      return { success: false, message: "Test request failed" };
    }
  }

  async function loadData() {
    setLoading(true);
    try {
      const [catalogRes, installedRes] = await Promise.all([
        fetchWithAuth("/api/integrations/catalog").then((r) => r.json()),
        fetchWithAuth(`/api/agents/${agentId}/integrations`).then((r) => r.json()),
      ]);
      setCatalog(Array.isArray(catalogRes) ? catalogRes : []);
      const installedItems = Array.isArray(installedRes) ? installedRes : [];
      setInstalled(installedItems);
      setSelectedIntegrationId((current) => {
        if (!installedItems.length) return null;
        if (current && installedItems.some((item) => item.id === current)) return current;
        return installedItems[0].id;
      });
    } catch (e) {
      console.error("Failed to load integrations:", e);
    }
    setLoading(false);
  }

  async function handleConnect(catalogItem, configValues = {}) {
    try {
      // Extract token: first password+required field from configFields
      const configFields = catalogItem.configFields || [];
      const tokenField = configFields.find((f) => f.type === "password" && f.required);
      const token = tokenField ? configValues[tokenField.key] || "" : "";

      const res = await fetchWithAuth(`/api/agents/${agentId}/integrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: catalogItem.id, token, config: configValues }),
      });
      if (res.ok) {
        const newIntegration = await res.json();
        toast.success(`${catalogItem.name} connected`);

        // Auto-test after connecting
        let testResult = null;
        try {
          const testRes = await fetchWithAuth(
            `/api/agents/${agentId}/integrations/${newIntegration.id}/test`,
            {
              method: "POST",
            },
          );
          testResult = await testRes.json();
        } catch {
          testResult = { success: false, message: "Test could not be completed" };
        }

        await loadData();
        emitAgentDataChanged({ agentId, scope: "integrations" });
        return { integration: newIntegration, testResult };
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to connect");
        return { testResult: { success: false, message: data.error || "Failed to connect" } };
      }
    } catch {
      toast.error("Failed to connect integration");
      return { testResult: { success: false, message: "Failed to connect integration" } };
    }
  }

  async function handleOAuthConnect(catalogItem, configValues = {}) {
    try {
      const redirectPath =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : `/app/agents/${agentId}`;
      const res = await fetchWithAuth(
        `/api/agents/${agentId}/integrations/${catalogItem.id}/oauth/start`,
        {
          method: "POST",
          body: JSON.stringify({ redirectPath, config: configValues }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || `Failed to connect ${catalogItem.name}`);
        return { testResult: { success: false, message: data.error || "OAuth failed" } };
      }
      if (typeof window !== "undefined" && data.authorizationUrl) {
        window.location.assign(data.authorizationUrl);
      }
      return { testResult: null };
    } catch {
      toast.error(`Failed to connect ${catalogItem.name}`);
      return { testResult: { success: false, message: "Failed to start OAuth" } };
    }
  }

  async function handleTest(integration) {
    return runIntegrationTest(integration);
  }

  async function handleDisconnect(integration) {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/integrations/${integration.id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success("Integration disconnected");
        emitAgentDataChanged({ agentId, scope: "integrations" });
      } else {
        toast.error(data.error || "Failed to disconnect");
      }
      await loadData();
    } catch {
      toast.error("Failed to disconnect integration");
    }
  }

  async function handleSave(integration, configValues = {}) {
    setSavingIntegration(true);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/integrations/${integration.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: configValues }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Failed to save integration");
        return;
      }
      toast.success("Integration updated");
      await loadData();
      emitAgentDataChanged({ agentId, scope: "integrations" });
      if (integration?.provider === "email") {
        await runIntegrationTest(integration, { silentSuccess: true });
      }
    } catch {
      toast.error("Failed to save integration");
    } finally {
      setSavingIntegration(false);
    }
  }

  const filteredCatalog = catalog.filter((item) => {
    const matchesSearch =
      !search ||
      item.name?.toLowerCase().includes(search.toLowerCase()) ||
      item.description?.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = activeCategory === "all" || item.category === activeCategory;
    return matchesSearch && matchesCategory;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  const selectedIntegration =
    installed.find((item) => item.id === selectedIntegrationId) || installed[0] || null;
  const selectedCatalogItem =
    catalog.find(
      (item) =>
        item.id === selectedIntegration?.provider || item.id === selectedIntegration?.catalog_id,
    ) || null;

  return (
    <div className="space-y-6">
      {/* Active Integrations */}
      {installed.length > 0 && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
          <ActiveIntegrationsPanel
            integrations={installed}
            selectedId={selectedIntegration?.id || null}
            onSelect={(integration: any) => setSelectedIntegrationId(integration.id)}
          />
          <div className="xl:sticky xl:top-4">
            <IntegrationDetailPanel
              integration={selectedIntegration}
              catalogItem={selectedCatalogItem}
              onTest={handleTest}
              onSave={handleSave}
              saving={savingIntegration}
              onDisconnect={() => {
                if (selectedIntegration) handleDisconnect(selectedIntegration);
              }}
            />
          </div>
        </div>
      )}

      {/* MCP Servers */}
      <McpServersSection agentId={agentId} />

      {/* Catalog Browser */}
      <div className="space-y-4">
        <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
          <Puzzle size={16} className="text-blue-600" />
          Integration Catalog
        </h3>

        {/* Search + Category Filters */}
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search integrations..."
              className="w-full pl-9 pr-4 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div className="flex gap-1 overflow-x-auto">
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`px-3 py-1.5 text-[10px] font-bold rounded-lg whitespace-nowrap transition-colors ${
                  activeCategory === cat.id
                    ? "bg-blue-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* Catalog Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredCatalog.map((item) => {
            const inst = installed.find((i) => i.provider === item.id || i.catalog_id === item.id);
            const oauthConnect = item.authType === "oauth2";
            return (
              <IntegrationCard
                key={item.id}
                item={item}
                installed={inst || null}
                submitLabel={
                  oauthConnect
                    ? item.id === "twitter"
                      ? "Authorize with X"
                      : `Authorize with ${item.name}`
                    : undefined
                }
                onConnect={(configValues) =>
                  oauthConnect
                    ? handleOAuthConnect(item, configValues)
                    : handleConnect(item, configValues)
                }
                onDisconnect={() => {
                  if (inst) handleDisconnect(inst);
                }}
                onTest={handleTest}
              />
            );
          })}
        </div>

        {filteredCatalog.length === 0 && (
          <div className="text-center py-8 text-slate-400 text-sm">
            No integrations found matching your search.
          </div>
        )}
      </div>
    </div>
  );
}
