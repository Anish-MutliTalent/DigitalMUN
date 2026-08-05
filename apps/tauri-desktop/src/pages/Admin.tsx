/**
 * @mun/desktop renderer — Admin screen
 *
 * System-wide oversight: health dashboard, committee management with emergency
 * stop/resume, user management, active sessions, the tamper-evident audit log
 * (with chain verification), and AI-detection rule management.
 */

import { useEffect, useState } from 'react';
import {
  AlertOctagon,
  CheckCircle2,
  Download,
  Plus,
  Power,
  ShieldCheck,
  ShieldX,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  SectionTitle,
  Select,
  Stat,
  formatTime,
  formatDuration,
} from '../components/ui';
import type { Committee, Delegate, Role, SystemHealth } from '@mun/protocol';

type Tab = 'health' | 'committees' | 'users' | 'sessions' | 'audit' | 'rules' | 'settings';

interface UserRow {
  id: string;
  username: string;
  role: Role;
  displayName: string;
  createdAt: number;
  hasDelegate: boolean;
  committeeId: string | null;
}
interface SessionRow {
  id: string;
  userId: string;
  role: Role;
  platform: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}
interface RuleRow {
  id: string;
  name: string;
  platform: string;
  matchField: string;
  patternType: string;
  pattern: string;
  enabled: boolean;
  severity: string;
  category: string;
}

export function AdminScreen() {
  const [tab, setTab] = useState<Tab>('health');
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'health', label: 'Health' },
    { id: 'committees', label: 'Committees' },
    { id: 'users', label: 'Users' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'audit', label: 'Audit Log' },
    { id: 'rules', label: 'AI Rules' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-1.5 text-sm ${tab === t.id ? 'bg-primary text-primary-fg' : 'bg-surface-2 text-muted hover:text-text'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'health' && <HealthTab />}
      {tab === 'committees' && <CommitteesTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'sessions' && <SessionsTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  );
}

function HealthTab() {
  const systemHealth = useStore((s) => s.systemHealth) as SystemHealth | null;
  if (!systemHealth) return <EmptyState>Waiting for health telemetry…</EmptyState>;
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <Stat label="Uptime" value={formatDuration(systemHealth.uptimeMs)} />
      <Stat label="Connected delegates" value={systemHealth.connectedDelegates} tone="success" />
      <Stat label="Connected chairs" value={systemHealth.connectedChairs} />
      <Stat label="Committees" value={systemHealth.committees} />
      <Stat label="Open votes" value={systemHealth.activeVotes} tone="primary" />
      <Stat label="Warnings (1h)" value={systemHealth.warningsLastHour} tone="danger" />
      <Stat label="Events (1h)" value={systemHealth.monitorEventsLastHour} />
      <Stat label="WS connections" value={systemHealth.wsConnections} />
      <Stat label="DB latency" value={`${systemHealth.dbLatencyMs}ms`} tone={systemHealth.dbLatencyMs < 100 ? 'success' : 'warning'} />
      <Stat label="Status" value={systemHealth.healthy ? 'Healthy' : 'Degraded'} tone={systemHealth.healthy ? 'success' : 'danger'} />
    </div>
  );
}

function CommitteesTab() {
  const [items, setItems] = useState<Committee[]>([]);
  const [chairs, setChairs] = useState<Array<{ id: string; displayName: string }>>([]);
  const [vices, setVices] = useState<Array<{ id: string; displayName: string }>>([]);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [chairForCreate, setChairForCreate] = useState('');
  const [viceForCreate, setViceForCreate] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [delegations, setDelegations] = useState<Delegate[]>([]);
  const [newCountry, setNewCountry] = useState('');

  async function refresh() {
    const r = await api.apiRequest('GET', '/admin/committees');
    if (r.status === 200) setItems((r.data as { committees: Committee[] }).committees);
    const u = await api.apiRequest('GET', '/admin/users');
    if (u.status === 200) {
      setChairs(
        (u.data as { users: UserRow[] })
          .users.filter((x) => x.role === 'chair')
          .map((x) => ({ id: x.id, displayName: x.displayName })),
      );
      setVices(
        (u.data as { users: UserRow[] })
          .users.filter((x) => x.role === 'vice')
          .map((x) => ({ id: x.id, displayName: x.displayName })),
      );
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function selectCommittee(cid: string) {
    setSelectedId(cid);
    const r = await api.apiRequest('GET', `/committee/${cid}`);
    if (r.status === 200) setDelegations((r.data as { delegates: Delegate[] }).delegates ?? []);
  }

  async function create() {
    if (!name.trim() || !topic.trim()) return;
    setBusy(true);
    await api.apiRequest('POST', '/admin/committee', {
      name: name.trim(),
      topic: topic.trim(),
      chairUserId: chairForCreate || null,
      viceUserId: viceForCreate || null,
    });
    setBusy(false);
    setName(''); setTopic(''); setChairForCreate(''); setViceForCreate('');
    void refresh();
  }
  async function setChair(cid: string, chairUserId: string) {
    await api.apiRequest('PUT', `/admin/committee/${cid}`, { chairUserId: chairUserId || null });
    void refresh();
  }
  async function setVice(cid: string, viceUserId: string) {
    await api.apiRequest('PUT', `/admin/committee/${cid}`, { viceUserId: viceUserId || null });
    void refresh();
  }
  async function emergency(cid: string, stop: boolean) {
    await api.apiRequest('POST', `/admin/committee/${cid}/${stop ? 'emergency-stop' : 'emergency-resume'}`);
    void refresh();
  }
  async function addCountry() {
    if (!selectedId || !newCountry.trim()) return;
    await api.apiRequest('POST', `/admin/committee/${selectedId}/delegation`, { country: newCountry.trim() });
    setNewCountry('');
    void selectCommittee(selectedId);
  }
  async function removeCountry(did: string) {
    if (!selectedId) return;
    await api.apiRequest('DELETE', `/admin/committee/${selectedId}/delegation/${did}`);
    void selectCommittee(selectedId);
  }

  const selected = items.find((c) => c.id === selectedId);
  const chairNameOf = (cid: string | null) =>
    cid ? chairs.find((c) => c.id === cid)?.displayName ?? 'Unknown' : null;
  const viceNameOf = (cid: string | null) =>
    cid ? vices.find((c) => c.id === cid)?.displayName ?? 'Unknown' : null;

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Create Committee</SectionTitle>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <Select value={chairForCreate} onChange={(e) => setChairForCreate(e.target.value)} title="Chair (optional)">
            <option value="">No chair yet</option>
            {chairs.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName}</option>
            ))}
          </Select>
          <Select value={viceForCreate} onChange={(e) => setViceForCreate(e.target.value)} title="Vice Chair (optional)">
            <option value="">No vice yet</option>
            {vices.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName}</option>
            ))}
          </Select>
          <Button onClick={create} disabled={busy || !name || !topic}><Plus size={14} /> Create</Button>
        </div>
        {chairs.length === 0 && (
          <p className="mt-2 text-xs text-warning">No chair users exist yet — create one in the Users tab first.</p>
        )}
      </Card>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Committees</SectionTitle>
          {items.length === 0 ? <EmptyState>No committees.</EmptyState> : (
            <div className="space-y-2">
              {items.map((c) => (
                <div
                  key={c.id}
                  className={`rounded-lg border p-3 ${selectedId === c.id ? 'border-primary' : 'border-border'}`}
                >
                  <div className="flex items-center justify-between">
                    <button className="text-left" onClick={() => void selectCommittee(c.id)}>
                      <div className="text-sm font-medium">{c.name}</div>
                      <div className="text-xs text-muted">{c.topic}</div>
                    </button>
                    <div className="flex items-center gap-2">
                      <Badge tone={c.status === 'active' ? 'success' : c.status === 'break' || c.status === 'paused' ? 'warning' : 'danger'}>{c.status}</Badge>
                      {c.status === 'emergency_stopped' ? (
                        <Button variant="ghost" className="!py-1 !text-xs" onClick={() => emergency(c.id, false)}><Power size={12} /> Resume</Button>
                      ) : (
                        <Button variant="danger" className="!py-1 !text-xs" onClick={() => emergency(c.id, true)}><AlertOctagon size={12} /> Stop</Button>
                      )}
                    </div>
                  </div>
                  <div className="mt-1.5 text-xs text-muted flex gap-4">
                    <span>Chair: {chairNameOf(c.chairUserId) ?? <span className="text-warning">unassigned</span>}</span>
                    <span>Vice: {viceNameOf(c.viceUserId) ?? <span className="text-warning">unassigned</span>}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <SectionTitle>Committee Details{selected ? ` — ${selected.name}` : ''}</SectionTitle>
          {!selected ? (
            <EmptyState>Select a committee to manage its chair and countries.</EmptyState>
          ) : (
            <div className="space-y-4">
              {/* Chair assignment */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="mb-1 block text-xs font-medium text-muted">Chair</span>
                  <div className="flex gap-2">
                    <Select
                      value={selected.chairUserId ?? ''}
                      onChange={(e) => void setChair(selected.id, e.target.value)}
                    >
                      <option value="">Unassigned</option>
                      {chairs.map((c) => (
                        <option key={c.id} value={c.id}>{c.displayName}</option>
                      ))}
                    </Select>
                  </div>
                  {chairs.length === 0 && (
                    <p className="mt-1 text-xs text-warning">Create a chair user in the Users tab first.</p>
                  )}
                </div>
                <div>
                  <span className="mb-1 block text-xs font-medium text-muted">Vice Chair</span>
                  <div className="flex gap-2">
                    <Select
                      value={selected.viceUserId ?? ''}
                      onChange={(e) => void setVice(selected.id, e.target.value)}
                    >
                      <option value="">Unassigned</option>
                      {vices.map((c) => (
                        <option key={c.id} value={c.id}>{c.displayName}</option>
                      ))}
                    </Select>
                  </div>
                </div>
              </div>

              {/* Country delegations */}
              <div>
                <span className="mb-1 block text-xs font-medium text-muted">Country Delegations</span>
                <div className="flex gap-2">
                  <Input placeholder="Add country (e.g. France)" value={newCountry} onChange={(e) => setNewCountry(e.target.value)} />
                  <Button onClick={addCountry} disabled={!newCountry.trim()}><Plus size={14} /> Add</Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {delegations.length === 0 ? (
                    <span className="text-xs text-muted">No countries yet. Delegates join by selecting one of these.</span>
                  ) : (
                    delegations.map((d) => (
                      <span key={d.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs">
                        {d.country}
                        <button className="text-muted hover:text-danger" onClick={() => void removeCountry(d.id)} aria-label={`Remove ${d.country}`}>
                          <X size={12} />
                        </button>
                      </span>
                    ))
                  )}
                </div>
              </div>
              <p className="text-xs text-muted">Assign a chair, then add the country slate. Delegates sign in by selecting committee + country — no passwords.</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function UsersTab() {
  const [items, setItems] = useState<UserRow[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('chair');

  async function refresh() {
    const r = await api.apiRequest('GET', '/admin/users');
    if (r.status === 200) {
      // Delegates are auto-created (passwordless) via the Committees tab; show
      // only chairs/admins here.
      setItems((r.data as { users: UserRow[] }).users.filter((u) => u.role !== 'delegate'));
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function create() {
    if (!username || !password || !displayName) return;
    await api.apiRequest('POST', '/admin/users', { username, password, role, displayName });
    setUsername(''); setPassword(''); setDisplayName('');
    void refresh();
  }
  const setToast = useStore((s) => s.setToast);

  async function forceLogout(uid: string) {
    await api.apiRequest('POST', `/admin/users/${uid}/force-logout`);
  }
  async function deleteUser(uid: string) {
    if (confirm('Are you sure you want to delete this user?')) {
      const res = await api.apiRequest('DELETE', `/admin/users/${uid}`);
      if (res.status === 200) {
        void refresh();
      } else {
        setToast((res.data as any)?.message ?? 'Failed to delete user', 'danger');
      }
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Create Chair / Vice / Admin</SectionTitle>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
          <Input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <Input placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Input placeholder="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="chair">chair</option>
            <option value="vice">vice chair</option>
            <option value="admin">admin</option>
          </Select>
          <Button onClick={create} disabled={!username || !password || !displayName}><Plus size={14} /> Create</Button>
        </div>
        <p className="mt-2 text-xs text-muted">Delegates aren't created here — add their countries under Committees → Country Delegations; delegates sign in by selecting their country.</p>
      </Card>
      <Card>
        <SectionTitle>Chairs & Admins</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted"><tr className="text-left">
              <th className="pb-2">Username</th><th className="pb-2">Role</th><th className="pb-2">Display</th><th className="pb-2 text-right">Actions</th>
            </tr></thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id} className="border-t border-border">
                  <td className="py-2">{u.username}</td>
                  <td className="py-2"><Badge tone={u.role === 'admin' ? 'danger' : u.role === 'vice' ? 'warning' : 'primary'}>{u.role}</Badge></td>
                  <td className="py-2">{u.displayName}</td>
                  <td className="py-2 text-right">
                    <Button variant="ghost" className="!py-1 !text-xs mr-2" onClick={() => forceLogout(u.id)}>Force logout</Button>
                    <Button variant="danger" className="!py-1 !text-xs" onClick={() => void deleteUser(u.id)}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function SessionsTab() {
  const [items, setItems] = useState<SessionRow[]>([]);
  async function refresh() {
    const r = await api.apiRequest('GET', '/admin/sessions');
    if (r.status === 200) setItems((r.data as { sessions: SessionRow[] }).sessions);
  }
  useEffect(() => { void refresh(); }, []);
  return (
    <Card>
      <SectionTitle>Active Sessions</SectionTitle>
      {items.length === 0 ? <EmptyState>No active sessions.</EmptyState> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted"><tr className="text-left">
              <th className="pb-2">User</th><th className="pb-2">Role</th><th className="pb-2">Platform</th><th className="pb-2">Created</th><th className="pb-2">Last seen</th><th className="pb-2">Expires</th>
            </tr></thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="py-2 font-mono text-xs">{s.userId.slice(0, 8)}</td>
                  <td className="py-2">{s.role}</td>
                  <td className="py-2">{s.platform}</td>
                  <td className="py-2 text-xs text-muted">{formatTime(s.createdAt)}</td>
                  <td className="py-2 text-xs text-muted">{formatTime(s.lastSeenAt)}</td>
                  <td className="py-2 text-xs text-muted">{formatTime(s.expiresAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function AuditTab() {
  const [entries, setEntries] = useState<Array<{ seq: number; timestamp: number; actor: string; action: string; subject: string | null; detail: string }>>([]);
  const [verification, setVerification] = useState<{ valid: boolean; brokenAtSeq: number | null; count: number } | null>(null);

  async function refresh() {
    const r = await api.apiRequest('GET', '/admin/audit?limit=200');
    if (r.status === 200) {
      const d = r.data as { entries: typeof entries; verification: typeof verification };
      setEntries(d.entries);
      setVerification(d.verification);
    }
  }
  useEffect(() => { void refresh(); }, []);

  function exportLog() {
    const blob = new Blob([JSON.stringify({ entries, verification }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'audit-log.json'; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <SectionTitle action={<Button variant="ghost" className="!py-1 !text-xs" onClick={exportLog}><Download size={12} /> Export</Button>}>Audit Log</SectionTitle>
      {verification && (
        <div className={`mb-3 flex items-center gap-2 rounded-lg border p-2.5 text-sm ${verification.valid ? 'border-success/40 bg-success/10 text-success' : 'border-danger/40 bg-danger/10 text-danger'}`}>
          {verification.valid ? <><ShieldCheck size={16} /> Hash chain intact ({verification.count} entries)</> : <><ShieldX size={16} /> Chain BROKEN at seq {verification.brokenAtSeq}</>}
        </div>
      )}
      {entries.length === 0 ? <EmptyState>No audit entries.</EmptyState> : (
        <div className="max-h-[28rem] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="text-muted"><tr className="text-left">
              <th className="pb-2">Seq</th><th className="pb-2">Time</th><th className="pb-2">Actor</th><th className="pb-2">Action</th><th className="pb-2">Detail</th>
            </tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.seq} className="border-t border-border">
                  <td className="py-1.5 font-mono">{e.seq}</td>
                  <td className="py-1.5 text-muted">{formatTime(e.timestamp)}</td>
                  <td className="py-1.5 font-mono">{e.actor.slice(0, 8)}</td>
                  <td className="py-1.5">{e.action}</td>
                  <td className="py-1.5 text-muted">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RulesTab() {
  const [items, setItems] = useState<RuleRow[]>([]);
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [platform, setPlatform] = useState('all');

  async function refresh() {
    const r = await api.apiRequest('GET', '/admin/rules');
    if (r.status === 200) setItems((r.data as { rules: RuleRow[] }).rules);
  }
  useEffect(() => { void refresh(); }, []);

  async function create() {
    if (!name || !pattern) return;
    await api.apiRequest('POST', '/admin/rules', {
      name, platform, matchField: 'app_or_title', patternType: 'contains', pattern, enabled: true, severity: 'critical', category: 'ai_assistant',
    });
    setName(''); setPattern('');
    void refresh();
  }
  async function toggle(r: RuleRow) {
    await api.apiRequest('PUT', `/admin/rules/${r.id}`, { enabled: !r.enabled });
    void refresh();
  }

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Add AI-Detection Rule</SectionTitle>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
          <Input placeholder="Name (e.g. NewAI)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Pattern (e.g. newai)" value={pattern} onChange={(e) => setPattern(e.target.value)} />
          <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="all">all</option><option value="windows">windows</option><option value="macos">macos</option>
          </Select>
          <Button onClick={create} disabled={!name || !pattern}><Plus size={14} /> Add</Button>
        </div>
        <p className="mt-2 text-xs text-muted">New AI services can be added here at runtime — no app update required. Rules sync to every delegate instantly.</p>
      </Card>
      <Card>
        <SectionTitle>Rules</SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted"><tr className="text-left">
              <th className="pb-2">Name</th><th className="pb-2">Pattern</th><th className="pb-2">Platform</th><th className="pb-2">Severity</th><th className="pb-2 text-right">Enabled</th>
            </tr></thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-2">{r.name}</td>
                  <td className="py-2 font-mono text-xs">{r.pattern}</td>
                  <td className="py-2">{r.platform}</td>
                  <td className="py-2"><Badge tone={r.severity === 'critical' ? 'danger' : 'warning'}>{r.severity}</Badge></td>
                  <td className="py-2 text-right">
                    <button onClick={() => toggle(r)} className={`inline-flex items-center gap-1 text-xs ${r.enabled ? 'text-success' : 'text-muted'}`}>
                      {r.enabled ? <><CheckCircle2 size={14} /> on</> : <>off</>}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function SettingsTab() {
  const allowFileUploads = useStore((s) => s.allowFileUploads);
  const fetchSettings = useStore((s) => s.fetchSettings);
  const updateAllowFileUploads = useStore((s) => s.updateAllowFileUploads);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>Submission Policy &amp; Settings</SectionTitle>
        <div className="space-y-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border/40 pb-4">
            <div>
              <h4 className="text-sm font-semibold text-text">PDF / DOC File Upload Submissions</h4>
              <p className="text-xs text-muted mt-1 max-w-xl">
                Allow delegates to upload PDF or DOC/DOCX resolution files directly.
                When turned off, delegates can only submit resolutions via Google Doc links.
              </p>
            </div>
            <button
              onClick={() => void updateAllowFileUploads(!allowFileUploads)}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition shrink-0 ${
                allowFileUploads
                  ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/30'
                  : 'bg-rose-500/10 text-rose-500 border border-rose-500/30'
              }`}
            >
              {allowFileUploads ? (
                <>
                  <CheckCircle2 size={16} /> File Uploads Enabled
                </>
              ) : (
                <>
                  <X size={16} /> File Uploads Disabled
                </>
              )}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
