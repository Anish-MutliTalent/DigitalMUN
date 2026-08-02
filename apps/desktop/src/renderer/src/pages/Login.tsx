/**
 * @mun/desktop renderer — Login screen
 *
 * Two tabs:
 *  - Delegate: passwordless join by selecting committee + country.
 *  - Chair / Admin: username + password.
 *
 * Delegates have no credentials — they claim a (committee, country) delegation
 * slot. If the slot is already claimed by another device, the server reports
 * re-login required (chair approval).
 */

import { useEffect, useState } from 'react';
import { Settings, Users, UserCog } from 'lucide-react';
import { useStore } from '../store';
import { api } from '../api';
import { Button, Input, Card, Select } from '../components/ui';
import type { JoinOptionCommittee } from '@shared/ipc';
import logo from '../assets/logo.png';

type Tab = 'delegate' | 'staff';

export function LoginScreen() {
  const login = useStore((s) => s.login);
  const join = useStore((s) => s.join);
  const serverUrl = useStore((s) => s.serverUrl);
  const setServerUrl = useStore((s) => s.setServerUrl);

  const [tab, setTab] = useState<Tab>('delegate');
  const [url, setUrl] = useState(serverUrl);
  const [showSettings, setShowSettings] = useState(false);

  // Staff (chair/admin) form
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [relogin, setRelogin] = useState<{ message: string } | null>(null);

  // Delegate join form
  const [options, setOptions] = useState<JoinOptionCommittee[]>([]);
  const [committeeId, setCommitteeId] = useState('');
  const [country, setCountry] = useState('');
  const [loadingOptions, setLoadingOptions] = useState(false);

  async function refreshOptions() {
    setLoadingOptions(true);
    const opts = await api.getJoinOptions();
    setOptions(opts);
    setCommitteeId(opts[0]?.committeeId ?? '');
    setCountry('');
    setLoadingOptions(false);
  }

  useEffect(() => {
    if (tab === 'delegate') void refreshOptions();
  }, [tab, serverUrl]);

  const selectedCommittee = options.find((c) => c.committeeId === committeeId);
  const freeCountries = selectedCommittee?.countries.filter((c) => !c.taken) ?? [];
  const takenCountries = selectedCommittee?.countries.filter((c) => c.taken) ?? [];

  async function submitStaff(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setRelogin(null);
    const result = await login(username.trim(), password);
    setBusy(false);
    if (!result.ok && result.reloginRequired) {
      setRelogin({ message: result.message ?? 'Re-login required' });
    }
  }

  async function submitDelegate(e: React.FormEvent) {
    e.preventDefault();
    if (!committeeId || !country) return;
    setBusy(true);
    setRelogin(null);
    const result = await join(committeeId, country);
    setBusy(false);
    if (!result.ok && result.reloginRequired) {
      setRelogin({ message: result.message ?? 'Re-login required' });
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src={logo} alt="SAFE MUN 2026" className="h-14 w-14 rounded-full object-cover" />
          <h1 className="text-xl font-semibold">SAFE MUN 2026</h1>
          <p className="text-sm text-muted">Committee integrity monitoring</p>
        </div>

        {/* Tabs */}
        <div className="mb-3 flex gap-1.5 rounded-lg bg-surface-2 p-1">
          <button
            onClick={() => { setTab('delegate'); setRelogin(null); }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${tab === 'delegate' ? 'bg-surface text-text shadow' : 'text-muted'}`}
          >
            <Users size={14} /> Delegate
          </button>
          <button
            onClick={() => { setTab('staff'); setRelogin(null); }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${tab === 'staff' ? 'bg-surface text-text shadow' : 'text-muted'}`}
          >
            <UserCog size={14} /> Chair / Admin
          </button>
        </div>

        <Card>
          {tab === 'delegate' ? (
            <form onSubmit={submitDelegate} className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Committee</span>
                <Select
                  value={committeeId}
                  onChange={(e) => { setCommitteeId(e.target.value); setCountry(''); }}
                  disabled={loadingOptions || options.length === 0}
                >
                  {options.length === 0 && <option value="">{loadingOptions ? 'Loading…' : 'No committees'}</option>}
                  {options.map((c) => (
                    <option key={c.committeeId} value={c.committeeId}>{c.committeeName}</option>
                  ))}
                </Select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Country</span>
                <Select value={country} onChange={(e) => setCountry(e.target.value)} disabled={!committeeId}>
                  <option value="">Select your country…</option>
                  {freeCountries.map((c) => (
                    <option key={c.delegateId} value={c.country}>{c.country}</option>
                  ))}
                </Select>
              </label>
              {takenCountries.length > 0 && (
                <p className="text-xs text-muted">
                  Already signed in: {takenCountries.map((c) => c.country).join(', ')}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={busy || !committeeId || !country}>
                {busy ? 'Joining…' : 'Join committee'}
              </Button>
              <p className="text-xs text-muted">
                Delegates sign in by selecting their assigned committee and country — no password needed.
              </p>
            </form>
          ) : (
            <form onSubmit={submitStaff} className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Username</span>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Password</span>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </label>
              <Button type="submit" className="w-full" disabled={busy || !username || !password}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          )}

          {relogin && (
            <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
              {relogin.message}
            </div>
          )}
        </Card>

        <div className="mt-4 text-center">
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-text"
          >
            <Settings size={12} /> Server settings
          </button>
        </div>

        {showSettings && (
          <Card className="mt-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Server URL</span>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://host:8080" />
            </label>
            <Button variant="ghost" className="mt-2 w-full" onClick={() => void setServerUrl(url.trim())}>
              Save
            </Button>
          </Card>
        )}

        <p className="mt-6 text-center text-xs text-muted">
          Monitoring is transparent and metadata-only. No screens, audio, keystrokes, or documents are captured.
        </p>
      </div>
    </div>
  );
}
