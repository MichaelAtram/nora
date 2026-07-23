import { useEffect, useState } from "react";
import { Plus, Trash2, ChevronDown } from "lucide-react";
import { fetchWithAuth } from "../../../lib/api";

export default function ProfileSwitcher({ agentId, selectedProfile, onSelect, disabled }) {
  const [profiles, setProfiles] = useState<any[]>([{ name: "default", isDefault: true, running: true }]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/profiles`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.profiles)) setProfiles(data.profiles);
    } catch {
      /* keep last known list */
    }
  }

  useEffect(() => {
    if (agentId && !disabled) load();
  }, [agentId, disabled]);

  async function createProfile() {
    setError("");
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/profiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to create profile");
      setNewName("");
      setCreating(false);
      await load();
      if (data.profile?.name) onSelect(data.profile.name);
    } catch (e) {
      setError(e.message);
    }
  }

  async function deleteProfile(name) {
    if (!window.confirm(`Delete Hermes profile "${name}"? This removes its config and gateway.`)) return;
    const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/profiles/${name}`, { method: "DELETE" });
    if (res.ok) {
      if (selectedProfile === name) onSelect("default");
      await load();
    }
  }

  if (disabled) return null;

  const current = profiles.find((p) => p.name === selectedProfile) || profiles[0];

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <select
          value={selectedProfile}
          onChange={(e) => onSelect(e.target.value)}
          className="appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pl-3 pr-8 text-xs font-bold text-slate-700"
        >
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.displayName || p.name}{p.running ? " ●" : " ○"}
            </option>
          ))}
        </select>
        <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400" />
      </div>

      {current && !current.isDefault && (
        <button onClick={() => deleteProfile(current.name)} className="text-slate-400 hover:text-red-500" title="Delete profile">
          <Trash2 size={14} />
        </button>
      )}

      {creating ? (
        <span className="flex items-center gap-1">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="profile-name"
            className="w-32 rounded-lg border border-slate-200 px-2 py-1 text-xs"
          />
          <button onClick={createProfile} className="rounded-lg bg-blue-600 px-2 py-1 text-xs font-bold text-white">Create</button>
          <button onClick={() => { setCreating(false); setError(""); }} className="text-xs text-slate-400">Cancel</button>
        </span>
      ) : (
        <button onClick={() => setCreating(true)} className="flex items-center gap-1 text-xs font-bold text-blue-600" title="New profile">
          <Plus size={14} /> Profile
        </button>
      )}
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
