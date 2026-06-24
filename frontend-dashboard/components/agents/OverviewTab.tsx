import { useState, useEffect } from "react";
import {
  Bot,
  Cpu,
  MemoryStick,
  HardDrive,
  Globe,
  Clock,
  Activity,
  Power,
  RefreshCw,
  Loader2,
  Zap,
  Radio,
  ShieldCheck,
  Brain,
  Copy,
  Share2,
  AlertTriangle,
  XCircle,
  AlertOctagon,
} from "lucide-react";
import StatusBadge from "./StatusBadge";
import { fetchWithAuth } from "../../lib/api";
import {
  formatExecutionTargetLabel,
  formatRuntimePathLabel,
  formatSandboxProfileLabel,
  isHermesRuntime,
  isNemoClawSandbox,
  resolveAgentExecutionTarget,
  resolveAgentSandboxProfile,
  runtimeSupportsGateway,
  runtimeSupportsAgentHubSharing,
} from "../../lib/runtime";

function formatGatewayAddress(agent, browserHostname = "") {
  if (agent?.gateway_host && agent?.gateway_port) {
    return `${agent.gateway_host}:${agent.gateway_port}`;
  }

  if (agent?.gateway_host_port) {
    const publishedHost = agent.gateway_host || browserHostname;
    return publishedHost
      ? `${publishedHost}:${agent.gateway_host_port}`
      : `Port ${agent.gateway_host_port}`;
  }

  if (agent?.host) {
    return `${agent.host}:${agent.gateway_port || 18789}`;
  }

  return `Port ${agent?.gateway_port || 18789}`;
}

function formatRuntimeAddress(agent) {
  const host = agent?.runtime_host || agent?.host;
  const defaultPort = isHermesRuntime(agent) ? 8642 : 9090;
  const port = agent?.runtime_port || defaultPort;

  if (host) {
    return `${host}:${port}`;
  }

  return `Port ${port}`;
}

function toReplicaCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveKubernetesReplicaSnapshot(agent) {
  const replicas = agent?.runtime_status?.replicas || agent?.replicas;
  if (!replicas) return null;

  const snapshot = {
    desired: toReplicaCount(replicas.specReplicas ?? replicas.desiredReplicas ?? replicas.desired),
    current: toReplicaCount(replicas.replicas ?? replicas.currentReplicas ?? replicas.current),
    ready: toReplicaCount(replicas.readyReplicas ?? replicas.ready),
    available: toReplicaCount(replicas.availableReplicas ?? replicas.available),
    updated: toReplicaCount(replicas.updatedReplicas ?? replicas.updated),
  };

  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

function isKubernetesTarget(agent, executionTarget) {
  return [executionTarget, agent?.deploy_target, agent?.backend_type]
    .filter(Boolean)
    .some((value) => String(value).trim().toLowerCase().startsWith("k8s"));
}

function formatReplicaCount(value) {
  return value == null ? "—" : String(value);
}

export default function OverviewTab({
  agent,
  backendConfig,
  actionLoading,
  onStart,
  onStop,
  onRestart,
  onRedeploy,
  onDuplicate,
  onPublish,
}) {
  const [lastError, setLastError] = useState(null);
  const [browserHostname, setBrowserHostname] = useState("");
  const deployModeLabel = formatRuntimePathLabel(agent, backendConfig);
  const executionTarget = resolveAgentExecutionTarget(agent);
  const executionTargetLabel = formatExecutionTargetLabel(
    executionTarget,
    backendConfig,
    agent.runtime_family,
  );
  const sandboxLabel = formatSandboxProfileLabel(resolveAgentSandboxProfile(agent));
  const isNemoClawAgent = isNemoClawSandbox(agent);
  const isHermesAgent = isHermesRuntime(agent);
  const supportsGateway = runtimeSupportsGateway(agent);
  const supportsAgentHub = runtimeSupportsAgentHubSharing(agent);
  const gatewayAddress = formatGatewayAddress(agent, browserHostname);
  const runtimeAddress = formatRuntimeAddress(agent);
  const isKubernetesAgent = isKubernetesTarget(agent, executionTarget);
  const replicas = isKubernetesAgent ? resolveKubernetesReplicaSnapshot(agent) : null;
  // Adopted external runtimes are not provisioned by Nora, so lifecycle controls
  // (start/stop/restart/redeploy/duplicate) don't apply — Nora only monitors + proxies.
  const isExternal = String(agent?.deploy_target || "").toLowerCase() === "external";

  // Fetch last error event when agent is in error state
  useEffect(() => {
    if (agent.status !== "error") {
      setLastError(null);
      return;
    }
    fetchWithAuth(`/api/monitoring/events?agentId=${agent.id}&limit=1`)
      .then((r) => (r.ok ? r.json() : []))
      .then((events) => setLastError(events[0]?.message || null))
      .catch(() => {});
  }, [agent.status, agent.id]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setBrowserHostname(window.location.hostname || "");
  }, []);

  const isStaleQueued =
    agent.status === "queued" &&
    agent.created_at &&
    Date.now() - new Date(agent.created_at).getTime() > 5 * 60 * 1000;

  return (
    <div className="space-y-6">
      {/* Status Banners */}
      {isStaleQueued && (
        <div className="flex items-center gap-3 bg-yellow-50 border border-yellow-200 rounded-2xl px-5 py-3">
          <AlertTriangle size={18} className="text-yellow-600 shrink-0" />
          <div>
            <p className="text-sm font-bold text-yellow-800">
              Deployment is taking longer than expected
            </p>
            <p className="text-xs text-yellow-600">
              This agent is still waiting for a worker slot. Check the Logs tab for details.
            </p>
          </div>
        </div>
      )}

      {agent.status === "queued" && !isStaleQueued && (
        <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-2xl px-5 py-3">
          <Loader2 size={18} className="text-blue-600 animate-spin shrink-0" />
          <div>
            <p className="text-sm font-bold text-blue-800">Deployment queued</p>
            <p className="text-xs text-blue-600">A provisioner worker will pick this up shortly.</p>
          </div>
        </div>
      )}

      {agent.status === "deploying" && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3">
          <Loader2 size={18} className="text-amber-600 animate-spin shrink-0" />
          <div>
            <p className="text-sm font-bold text-amber-800">Provisioning in progress</p>
            <p className="text-xs text-amber-600">
              A worker has started the deployment. Image pull, bootstrap, and readiness checks are
              running now.
            </p>
          </div>
        </div>
      )}

      {agent.status === "stopped" && agent.paused_reason === "budget_exceeded" && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3">
          <AlertOctagon size={18} className="text-amber-600 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-bold text-amber-800">Paused — budget cap reached</p>
            <p className="text-xs text-amber-600">
              This agent hit its LLM spend cap and was stopped automatically. Raise or remove the
              cap in Settings, then start the agent; restarting without changing the cap re-pauses
              it on the next check.
            </p>
          </div>
          <button
            onClick={onStart}
            disabled={!!actionLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white text-xs font-bold rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50 shrink-0"
          >
            {actionLoading === "start" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Power size={12} />
            )}
            Resume
          </button>
        </div>
      )}

      {agent.status === "error" && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-2xl px-5 py-3">
          <XCircle size={18} className="text-red-600 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-bold text-red-800">Deployment failed</p>
            <p className="text-xs text-red-600">
              {lastError || "An error occurred during provisioning."}
            </p>
          </div>
          <button
            onClick={onRedeploy}
            disabled={!!actionLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 shrink-0"
          >
            {actionLoading === "redeploy" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            Redeploy
          </button>
        </div>
      )}

      {agent.status === "warning" && (
        <div className="flex items-center gap-3 bg-orange-50 border border-orange-200 rounded-2xl px-5 py-3">
          <AlertOctagon size={18} className="text-orange-600 shrink-0" />
          <div>
            <p className="text-sm font-bold text-orange-800">
              {isHermesAgent ? "Runtime health check failed" : "Gateway health check failed"}
            </p>
            <p className="text-xs text-orange-600">
              {isHermesAgent
                ? "Agent deployed but the Hermes API server is not responding yet. It may still be starting up."
                : "Agent deployed but the gateway is not responding. It may still be starting up."}
            </p>
          </div>
        </div>
      )}

      {/* External runtime notice */}
      {isExternal && (
        <div className="flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-5 py-3">
          <Globe size={18} className="mt-0.5 shrink-0 text-blue-600" />
          <div>
            <p className="text-sm font-bold text-blue-800">External runtime</p>
            <p className="text-xs text-blue-600">
              This runtime was adopted by URL and runs outside Nora. Nora monitors and proxies it,
              but lifecycle controls (start, stop, restart, redeploy) are unavailable. Use
              “Deregister” in Settings to remove it from Nora — the runtime itself is not stopped.
            </p>
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={onDuplicate}
          disabled={!!actionLoading || isExternal}
          className="flex items-center gap-2 px-4 py-2.5 bg-slate-50 border border-slate-200 text-slate-700 hover:bg-slate-100 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
        >
          {actionLoading === "duplicate" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Copy size={14} />
          )}
          Duplicate
        </button>
        {supportsAgentHub ? (
          <button
            onClick={onPublish}
            disabled={!!actionLoading}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
          >
            {actionLoading === "publish" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Share2 size={14} />
            )}
            Share to Agent Hub
          </button>
        ) : null}
        {!isExternal && agent.status === "running" && (
          <>
            <button
              onClick={onStop}
              disabled={!!actionLoading}
              className="flex items-center gap-2 px-4 py-2.5 bg-yellow-50 border border-yellow-200 text-yellow-700 hover:bg-yellow-100 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
            >
              {actionLoading === "stop" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Power size={14} />
              )}
              Stop Agent
            </button>
            <button
              onClick={onRestart}
              disabled={!!actionLoading}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
            >
              {actionLoading === "restart" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              Restart
            </button>
          </>
        )}
        {!isExternal && agent.status === "stopped" && (
          <button
            onClick={onStart}
            disabled={!!actionLoading}
            className="flex items-center gap-2 px-4 py-2.5 bg-green-50 border border-green-200 text-green-700 hover:bg-green-100 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
          >
            {actionLoading === "start" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Power size={14} />
            )}
            Start Agent
          </button>
        )}
        {!isExternal && (agent.status === "error" || agent.status === "stopped") && (
          <button
            onClick={onRedeploy}
            disabled={!!actionLoading}
            className="flex items-center gap-2 px-4 py-2.5 bg-purple-50 border border-purple-200 text-purple-700 hover:bg-purple-100 text-xs font-bold rounded-xl transition-all disabled:opacity-50"
          >
            {actionLoading === "redeploy" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Redeploy
          </button>
        )}
      </div>

      {/* Gateway Badge */}
      {agent.status === "running" && supportsGateway && (
        <div className="flex items-center gap-3 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl px-5 py-3">
          <div className="w-8 h-8 bg-blue-600 rounded-xl flex items-center justify-center">
            <Zap size={16} className="text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-800">OpenClaw Gateway Active</p>
            <p className="text-[10px] text-slate-500">
              {gatewayAddress} &bull; Chat, Sessions, Cron, Tools available in the OpenClaw tab
            </p>
          </div>
          <Radio size={14} className="ml-auto text-green-500 animate-pulse" />
        </div>
      )}

      {agent.status === "running" && isHermesAgent && (
        <div className="flex items-center gap-3 bg-gradient-to-r from-blue-50 to-cyan-50 border border-blue-200 rounded-2xl px-5 py-3">
          <div className="w-8 h-8 bg-blue-600 rounded-xl flex items-center justify-center">
            <Bot size={16} className="text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-800">Hermes API Server Active</p>
            <p className="text-[10px] text-slate-500">
              {runtimeAddress} &bull; Hermes WebUI, logs, and terminal are available from Nora
            </p>
          </div>
          <Radio size={14} className="ml-auto text-green-500 animate-pulse" />
        </div>
      )}

      {/* NemoClaw Sandbox Badge */}
      {isNemoClawAgent && agent.status === "running" && (
        <div className="flex items-center gap-3 bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-2xl px-5 py-3">
          <div className="w-8 h-8 bg-green-600 rounded-xl flex items-center justify-center">
            <ShieldCheck size={16} className="text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-slate-800">NemoClaw Secure Sandbox</p>
            <p className="text-[10px] text-slate-500">
              NVIDIA Nemotron inference &bull; Deny-by-default network &bull; Capability-restricted
            </p>
          </div>
          <Brain size={14} className="ml-auto text-green-500" />
        </div>
      )}

      {/* Resource Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        {[
          { label: "vCPU", value: agent.vcpu || "2", icon: Cpu, color: "text-blue-600" },
          {
            label: "RAM",
            value: `${agent.ram_mb ? agent.ram_mb / 1024 : 2} GB`,
            icon: MemoryStick,
            color: "text-emerald-600",
          },
          {
            label: "Disk",
            value: `${agent.disk_gb || 20} GB`,
            icon: HardDrive,
            color: "text-purple-600",
          },
          {
            label: isHermesAgent ? "Runtime API" : "Host",
            value: isHermesAgent ? runtimeAddress || "—" : gatewayAddress || "—",
            icon: Globe,
            color: "text-orange-600",
          },
        ].map((item) => (
          <div key={item.label} className="bg-slate-50 border border-slate-200 rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <item.icon size={16} className={item.color} />
              <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest">
                {item.label}
              </span>
            </div>
            <p className="text-lg font-black text-slate-900">{item.value}</p>
          </div>
        ))}
      </div>

      {/* Details */}
      <section className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <Activity size={18} className="text-blue-600" />
          Details
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-8">
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
              Status
            </label>
            <div className="mt-1">
              <StatusBadge status={agent.status} />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
              Runtime Path
            </label>
            <p className="text-sm text-slate-900 mt-1">{deployModeLabel}</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
              Execution Target
            </label>
            <p className="text-sm text-slate-900 mt-1">{executionTargetLabel}</p>
          </div>
          {isKubernetesAgent ? (
            <div>
              <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                Pod Replicas
              </label>
              <p className="text-sm text-slate-900 mt-1">
                {replicas
                  ? `${formatReplicaCount(replicas.ready)}/${formatReplicaCount(replicas.desired)} ready`
                  : "—"}
              </p>
              {replicas ? (
                <p className="text-xs text-slate-500 mt-1">
                  Current {formatReplicaCount(replicas.current)} · Available{" "}
                  {formatReplicaCount(replicas.available)} · Updated{" "}
                  {formatReplicaCount(replicas.updated)}
                </p>
              ) : null}
            </div>
          ) : null}
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
              Sandbox
            </label>
            <p className="text-sm text-slate-900 mt-1">{sandboxLabel}</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
              Container Name
            </label>
            <p className="text-sm text-slate-900 mt-1 font-mono break-all">
              {agent.container_name || "—"}
            </p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
              Container ID
            </label>
            <p className="text-sm text-slate-900 mt-1 font-mono break-all">
              {agent.container_id || "—"}
            </p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
              Image
            </label>
            <p className="text-sm text-slate-900 mt-1">{agent.image || "node:24-slim"}</p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
              Created
            </label>
            <p className="text-sm text-slate-900 mt-1">
              {agent.created_at ? new Date(agent.created_at).toLocaleString() : "—"}
            </p>
          </div>
          <div>
            <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
              Runtime Host
            </label>
            <p className="text-sm text-slate-900 mt-1">
              {agent.runtime_host || agent.host || agent.node || "—"}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
