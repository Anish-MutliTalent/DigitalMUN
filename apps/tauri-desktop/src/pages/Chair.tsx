/**
 * @mun/desktop renderer — Chair screen
 *
 * Designed to match the SAFE MUN 2026 Chair UI reference:
 * - Top card with committee info, stats, and export button
 * - Clean sidebar contained in a card with gold active tab indicators
 * - Scrollable main right card for content
 */

import { useState, useEffect } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Coffee,
  Download,
  ExternalLink,
  FileText,
  ListChecks,
  Pause,
  Play,
  Plus,
  ShieldOff,
  ShieldCheck,
  Timer,
  Trash2,
  UserX,
  Users,
  Vote as VoteIcon,
  Search,
  Filter,
  Info,
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
  StatusDot,
  formatTime,
  formatDuration,
} from '../components/ui';
import type { Attendance, Delegate, Warning } from '@mun/protocol';

type Tab = 'rollcall' | 'voting' | 'break' | 'resos' | 'warnings';

export function ChairScreen() {
  const committee = useStore((s) => s.currentCommittee);
  const delegates = useStore((s) => s.delegates);
  const delegateStatus = useStore((s) => s.delegateStatus);
  const feed = useStore((s) => s.monitoringFeed);
  const warnings = useStore((s) => s.warnings);
  const votes = useStore((s) => s.votes);
  const voteResults = useStore((s) => s.voteResults);
  const activeBreak = useStore((s) => s.activeBreak);
  const setToast = useStore((s) => s.setToast);

  const cid = committee?.id ?? '';
  const [tab, setTab] = useState<Tab>('rollcall');
  const [feedOpen, setFeedOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [breakLabel, setBreakLabel] = useState('');
  const [breakStart, setBreakStart] = useState('');
  const [breakEnd, setBreakEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [disablingDelegate, setDisablingDelegate] = useState<Delegate | null>(null);
  const [disableReason, setDisableReason] = useState<string>("YOU'VE BEEN GAGGED");

  const submissions = useStore((s) => s.submissions);
  const refreshSubmissions = useStore((s) => s.refreshSubmissions);
  const markSubmissionReviewed = useStore((s) => s.markSubmissionReviewed);
  const deleteSubmission = useStore((s) => s.deleteSubmission);
  const openSubmissionFile = useStore((s) => s.openSubmissionFile);
  const openSubmissionLink = useStore((s) => s.openSubmissionLink);

  useEffect(() => {
    if (cid) void refreshSubmissions(cid);
  }, [cid, refreshSubmissions]);

  async function req(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    setBusy(true);
    const r = await api.apiRequest(method, path, body);
    setBusy(false);
    if (r.status >= 400) {
      const data = r.data as { message?: string };
      setToast({ kind: 'error', message: data?.message ?? `Error ${r.status}` });
    }
    return r;
  }

  async function setAttendance(d: Delegate, attendance: Attendance) {
    await req('POST', `/committee/${cid}/delegate/${d.id}/attendance`, { attendance });
  }
  async function toggleEnabled(d: Delegate) {
    if (d.enabled) {
      setDisableReason("YOU'VE BEEN GAGGED");
      setDisablingDelegate(d);
    } else {
      await req('POST', `/committee/${cid}/delegate/${d.id}/enable`);
    }
  }
  async function confirmDisable() {
    if (!disablingDelegate) return;
    await req('POST', `/committee/${cid}/delegate/${disablingDelegate.id}/disable`, { reason: disableReason });
    setDisablingDelegate(null);
  }
  async function forceLogout(d: Delegate) {
    await req('POST', `/committee/${cid}/delegate/${d.id}/force-logout`);
  }
  async function acknowledge(w: Warning) {
    await req('POST', `/committee/${cid}/warnings/${w.id}/ack`);
  }
  async function openVote() {
    if (!question.trim()) return;
    await req('POST', `/committee/${cid}/vote`, { question: question.trim() });
    setQuestion('');
  }
  async function closeVote(vid: string) {
    await req('POST', `/committee/${cid}/vote/${vid}/close`);
  }
  async function revealVote(vid: string, ready: boolean) {
    if (!ready) {
      setToast({ kind: 'warning', message: 'All enabled delegates must vote before reveal.' });
      return;
    }
    await req('POST', `/committee/${cid}/vote/${vid}/reveal`);
  }
  async function pauseResume() {
    if (committee?.status === 'active') await req('POST', `/committee/${cid}/pause`);
    else if (committee?.status === 'paused') await req('POST', `/committee/${cid}/resume`);
  }
  async function scheduleBreak() {
    const startAt = breakStart ? new Date(breakStart).getTime() : NaN;
    const endAt = breakEnd ? new Date(breakEnd).getTime() : NaN;
    if (!breakLabel.trim() || !Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
      setToast({ kind: 'error', message: 'Provide a valid start/end time.' });
      return;
    }
    await req('POST', `/committee/${cid}/breaks`, { label: breakLabel.trim(), startAt, endAt });
    setBreakLabel('');
    setBreakStart('');
    setBreakEnd('');
  }
  async function cancelBreak(bid: string) {
    await req('DELETE', `/committee/${cid}/breaks/${bid}`);
  }
  async function exportLogs() {
    const r = await api.apiRequest('GET', `/committee/${cid}/export`);
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `committee-${cid}-log.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!committee) return <EmptyState>No committee assigned.</EmptyState>;

  const committeeWarnings = warnings.filter((w) => w.committeeId === cid);
  const unacked = committeeWarnings.filter((w) => !w.acknowledged).length;
  const connected = delegates.filter(
    (d) => (delegateStatus[d.id]?.connectionStatus ?? d.connectionStatus) === 'connected',
  ).length;
  const openVotes = votes.filter((v) => v.status === 'open').length;
  const eligibleCount = delegates.filter(
    (d) => d.enabled && (d.attendance === 'present' || d.attendance === 'voting'),
  ).length;
  const unreviewedSubs = submissions.filter((s) => s.committeeId === cid && s.status === 'submitted').length;

  const filteredDelegates = delegates.filter((d) => 
    d.country.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const nav: Array<{ id: Tab; label: string; icon: React.ReactNode; badge?: number }> = [
    { id: 'rollcall', label: 'Roll call', icon: <Users size={16} /> },
    { id: 'voting', label: 'Voting', icon: <VoteIcon size={16} />, badge: openVotes || undefined },
    { id: 'break', label: 'Break', icon: <Coffee size={16} /> },
    { id: 'resos', label: 'Resos & Dirs', icon: <FileText size={16} />, badge: unreviewedSubs || undefined },
    { id: 'warnings', label: 'Warnings & Logs', icon: <AlertTriangle size={16} />, badge: unacked || undefined },
  ];

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-6">
      {/* ─── Top Committee Card ────────────────────────────────────────────── */}
      <Card className="flex shrink-0 flex-col md:flex-row md:items-center justify-between p-5 py-6">
        <div className="flex items-center gap-5 px-2">
          <div>
            <div className="text-xl font-semibold text-text font-sans">
              {committee.name}
            </div>
            <div className="text-[13px] text-muted mt-0.5">
              {committee.topic}
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center md:mt-0 gap-8">
          <div className="flex flex-col items-center">
            <div className="flex items-center gap-1.5 font-medium text-text">
              <Users size={14} className="text-muted" /> {delegates.length}
            </div>
            <div className="text-[11px] uppercase tracking-wider text-muted mt-0.5">Delegates</div>
          </div>
          <div className="h-8 w-[1px] bg-border/60" />
          <div className="flex flex-col items-center">
            <div className="flex items-center gap-1.5 font-medium text-text">
              <StatusDot tone="success" /> {connected}
            </div>
            <div className="text-[11px] uppercase tracking-wider text-muted mt-0.5">Connected</div>
          </div>
          <div className="h-8 w-[1px] bg-border/60" />
          <div className="flex flex-col items-center">
            <Badge tone={committee.status === 'active' ? 'success' : committee.status === 'break' ? 'warning' : 'danger'}>
              {committee.status === 'active' ? 'Active' : committee.status}
            </Badge>
            <div className="text-[11px] uppercase tracking-wider text-muted mt-1.5">Status</div>
          </div>
          <div className="h-8 w-[1px] bg-border/60" />
          <button
            onClick={exportLogs}
            disabled={busy}
            className="flex items-center gap-2 rounded-xl bg-[#1C1D21] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-black disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-slate-200 shadow-sm"
          >
            <Download size={14} /> Export
          </button>
        </div>
      </Card>

      {/* ─── Main Content Grid ─────────────────────────────────────────────── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
        
        {/* Sidebar */}
        <Card className="flex flex-col overflow-y-auto p-2">
          <nav className="flex flex-col space-y-1.5">
            {nav.map((n) => {
              const active = tab === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => setTab(n.id)}
                  className={`group flex items-center gap-3 rounded-lg px-3 py-3 text-[13px] font-medium transition-all ${
                    active
                      ? 'border-l-[3px] border-amber-600 bg-surface-2 text-text shadow-sm dark:bg-surface dark:border-amber-500'
                      : 'border-l-[3px] border-transparent text-muted hover:bg-surface/50 hover:text-text'
                  }`}
                >
                  <span className={active ? 'text-amber-700 dark:text-amber-500' : 'text-muted'}>
                    {n.icon}
                  </span>
                  <span className="flex-1 text-left">{n.label}</span>
                  {n.badge ? (
                    <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-700 dark:bg-amber-900/50 dark:text-amber-400">
                      {n.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </Card>

        {/* Content Area */}
        <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden !p-0">
          <div className="flex-1 overflow-y-auto p-6 md:px-8 md:py-6">
            
            {tab === 'rollcall' && (
              <div className="pb-2">
                <div className="mb-5 flex flex-col items-start gap-4 md:flex-row md:items-center justify-between border-b border-border/50 pb-5">
                  <SectionTitle underline={true} underlineClass="bg-amber-600 dark:bg-amber-500" className="!mb-0">
                    Roll Call
                  </SectionTitle>
                  <div className="flex items-center gap-3 w-full md:w-auto">
                    <div className="relative flex-1 md:w-64">
                      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                      <Input
                        placeholder="Search country..."
                        className="pl-9 !py-1.5 !text-[13px] w-full"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                    <Button variant="ghost" className="!py-1.5 !text-[13px] bg-surface-2 gap-2 border border-border/50">
                      <Filter size={14} /> Filters
                    </Button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="text-left text-xs font-semibold text-muted border-b border-border/40">
                        <th className="pb-3 pt-1 font-medium">Country</th>
                        <th className="pb-3 pt-1 font-medium">Attendance</th>
                        <th className="pb-3 pt-1 font-medium">Status</th>
                        <th className="pb-3 pt-1 font-medium">App</th>
                        <th className="pb-3 pt-1 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/30">
                      {filteredDelegates.map((d) => {
                        const st = delegateStatus[d.id];
                        const conn = st?.connectionStatus ?? d.connectionStatus;
                        
                        // Status logic
                        let statusTone: 'success' | 'danger' | 'muted' = 'muted';
                        let statusText = 'Disabled';
                        if (d.enabled) {
                          if (conn === 'connected') {
                            statusTone = 'success';
                            statusText = 'Present';
                          } else {
                            statusTone = 'danger';
                            statusText = 'Offline';
                          }
                        }

                        return (
                          <tr key={d.id} className="group">
                            <td className="py-3.5 font-medium text-text">{d.country}</td>
                            <td className="py-3.5">
                              <Select
                                className="!py-1.5 !pr-8 !text-[13px] w-40 !rounded-lg border-border/60 bg-transparent shadow-none"
                                value={d.attendance}
                                onChange={(e) => void setAttendance(d, e.target.value as Attendance)}
                              >
                                <option value="not_checked_in">not_checked_in</option>
                                <option value="present">present</option>
                                <option value="voting">voting</option>
                                <option value="absent">absent</option>
                              </Select>
                            </td>
                            <td className="py-3.5">
                              <StatusDot tone={statusTone} label={statusText} />
                            </td>
                            <td className="py-3.5 text-muted">
                              {st?.currentAppName ?? '—'}
                            </td>
                            <td className="py-3.5 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  className="flex items-center gap-1.5 rounded-lg border border-border/40 px-2.5 py-1.5 text-muted transition hover:bg-surface hover:text-text"
                                  title={d.enabled ? 'Disable delegate' : 'Enable delegate'}
                                  onClick={() => void toggleEnabled(d)}
                                >
                                  {d.enabled ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
                                  <span>{d.enabled ? 'Disable' : 'Enable'}</span>
                                </button>
                                <button
                                  className="flex items-center gap-1.5 rounded-lg border border-border/40 px-2.5 py-1.5 text-muted transition hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 dark:hover:bg-rose-950/30 dark:hover:border-rose-900/50"
                                  title="Force logout"
                                  onClick={() => void forceLogout(d)}
                                >
                                  <UserX size={14} />
                                  <span>Logout</span>
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {filteredDelegates.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-muted">
                            No delegates match your search.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="mt-6 flex items-start gap-3 rounded-xl bg-stone-100/70 p-4 text-[13px] text-stone-600 dark:bg-stone-900/50 dark:text-stone-400 border border-stone-200/50 dark:border-stone-800">
                  <Info size={16} className="mt-0.5 shrink-0" />
                  <p className="leading-relaxed">
                    Set attendance to <strong>present</strong> or <strong>voting</strong> to make a delegate eligible to vote. Disable absent delegates so votes can complete.<br/>
                    Use <strong>Force logout</strong> to release a delegation so another device can claim it.
                  </p>
                </div>
              </div>
            )}

            {tab === 'voting' && (
              <div className="pb-2">
                <SectionTitle underlineClass="bg-amber-600">Voting Control</SectionTitle>
                <div className="mb-5 flex flex-col sm:flex-row gap-3">
                  <Input placeholder="Enter vote question…" className="flex-1" value={question} onChange={(e) => setQuestion(e.target.value)} />
                  <Button onClick={openVote} disabled={busy || !question.trim()} className="bg-amber-600 hover:bg-amber-500 !text-white border-0"><Plus size={14} /> Open vote</Button>
                </div>
                
                {votes.length === 0 ? (
                  <EmptyState>No votes recorded yet.</EmptyState>
                ) : (
                  <div className="space-y-3">
                    {votes.map((v) => {
                      const result = voteResults[v.id];
                      const ready = eligibleCount > 0 && v.submittedCount >= eligibleCount;
                      return (
                        <div key={v.id} className="flex flex-col sm:flex-row sm:items-center justify-between rounded-xl border border-border/60 bg-surface/50 p-4 gap-4">
                          <div>
                            <div className="font-medium text-[14px] text-text">{v.question}</div>
                            <div className="mt-1 flex items-center gap-3 text-[12px] text-muted">
                              <span>{formatTime(v.createdAt)}</span>
                              <span>•</span>
                              <span>{v.submittedCount} / {eligibleCount} submitted</span>
                              <span>•</span>
                              <Badge tone={v.status === 'open' ? 'warning' : 'neutral'}>{v.status}</Badge>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {v.status === 'revealed' && result ? (
                              <div className="flex gap-2">
                                <Badge tone="success">FOR {result.forCount}</Badge>
                                <Badge tone="danger">AGAINST {result.againstCount}</Badge>
                              </div>
                            ) : (
                              <>
                                {v.status === 'open' && (
                                  <Button variant="danger" className="!py-1.5 !px-4 !text-[13px]" onClick={() => closeVote(v.id)}>Close</Button>
                                )}
                                <Button
                                  className="!py-1.5 !px-4 !text-[13px]"
                                  disabled={v.status === 'revealed' || !ready}
                                  onClick={() => revealVote(v.id, ready)}
                                  title={ready ? 'Reveal results' : 'Waiting for all enabled delegates to vote'}
                                >
                                  Reveal
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {tab === 'break' && (
              <div className="space-y-6 pb-2">
                {activeBreak && (
                  <div className="flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
                    <Timer size={18} />
                    <span className="font-medium flex-1">On break: {activeBreak.label} (until {formatTime(activeBreak.endAt)})</span>
                    <Button variant="ghost" className="!py-1.5 !text-warning bg-warning/10" onClick={() => cancelBreak(activeBreak.id)}>Cancel Break</Button>
                  </div>
                )}
                <div className="rounded-xl border border-border/50 p-6">
                  <SectionTitle underlineClass="bg-amber-600">Manual Pause</SectionTitle>
                  <div className="flex items-center gap-4">
                    <Badge tone={committee.status === 'active' ? 'success' : committee.status === 'break' || committee.status === 'paused' ? 'warning' : 'danger'}>
                      {committee.status}
                    </Badge>
                    <Button
                      variant={committee.status === 'active' ? 'ghost' : 'primary'}
                      onClick={pauseResume}
                      disabled={busy || committee.status === 'break' || committee.status === 'emergency_stopped'}
                    >
                      {committee.status === 'active' ? <><Pause size={14} /> Pause committee</> : <><Play size={14} /> Resume committee</>}
                    </Button>
                    <span className="text-sm text-muted">Pausing stops monitoring; delegates see a Standby screen.</span>
                  </div>
                </div>
                <div className="rounded-xl border border-border/50 p-6">
                  <SectionTitle underlineClass="bg-amber-600">Schedule Break</SectionTitle>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                    <Input placeholder="Label (e.g. Lunch)" value={breakLabel} onChange={(e) => setBreakLabel(e.target.value)} />
                    <Input type="datetime-local" value={breakStart} onChange={(e) => setBreakStart(e.target.value)} />
                    <Input type="datetime-local" value={breakEnd} onChange={(e) => setBreakEnd(e.target.value)} />
                    <Button variant="ghost" className="bg-surface-2" onClick={scheduleBreak} disabled={busy}><Timer size={14} /> Schedule</Button>
                  </div>
                  <p className="mt-4 text-[13px] text-muted">During a scheduled break, monitoring pauses and delegate UIs show Standby; it resumes automatically when the break ends.</p>
                </div>
              </div>
            )}

            {tab === 'resos' && (
              <div className="pb-2">
                <SectionTitle underlineClass="bg-amber-600">Resolutions & Directives</SectionTitle>
                {submissions.length === 0 ? (
                  <EmptyState>No submissions yet.</EmptyState>
                ) : (
                  <div className="space-y-3">
                    {submissions.map((s) => (
                      <div key={s.id} className="flex flex-col sm:flex-row sm:items-center justify-between rounded-xl border border-border/60 bg-surface/50 p-4 gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-3">
                            <Badge tone={s.type === 'resolution' ? 'primary' : 'warning'}>{s.type}</Badge>
                            <span className="truncate text-[14px] font-medium text-text">{s.title}</span>
                          </div>
                          <div className="mt-1.5 text-[12px] text-muted flex items-center gap-2">
                            <span className="font-medium text-text/80">{s.delegateName} ({s.country})</span>
                            <span>•</span>
                            <span>{s.kind === 'file' ? s.fileName : 'External Link'}</span>
                            <span>•</span>
                            <span>{formatTime(s.submittedAt)}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge tone={s.status === 'reviewed' ? 'success' : 'neutral'}>{s.status}</Badge>
                          <div className="h-4 w-[1px] bg-border mx-2" />
                          {s.kind === 'file' ? (
                            <button className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-text transition border border-border/40" title="Open file" onClick={() => void openSubmissionFile(s.id, s.fileName ?? 'document')}>
                              <FileText size={15} />
                            </button>
                          ) : (
                            <button className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-text transition border border-border/40" title="Open link" onClick={() => void openSubmissionLink(s.url ?? '')}>
                              <ExternalLink size={15} />
                            </button>
                          )}
                          <Button variant="ghost" className="!py-2 !px-3 !text-[13px] border border-border/40" onClick={() => void markSubmissionReviewed(s.id)}>
                            {s.status === 'reviewed' ? 'Unreview' : 'Mark Reviewed'}
                          </Button>
                          <button className="rounded-lg p-2 text-muted hover:bg-rose-50 hover:text-rose-600 transition border border-border/40" title="Delete" onClick={() => void deleteSubmission(s.id)}>
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'warnings' && (
              <div className="space-y-6 pb-2">
                <div className="rounded-xl border border-border/50 p-6">
                  <div className="flex items-center justify-between mb-5">
                    <SectionTitle underlineClass="bg-amber-600" className="!mb-0">Warnings</SectionTitle>
                    {unacked > 0 && <Badge tone="danger">{unacked} Unacknowledged</Badge>}
                  </div>
                  {committeeWarnings.length === 0 ? (
                    <EmptyState>No warnings.</EmptyState>
                  ) : (
                    <div className="max-h-96 space-y-3 overflow-y-auto pr-2">
                      {committeeWarnings.slice(0, 80).map((w) => (
                        <div key={w.id} className="flex items-start gap-3 rounded-xl border border-border/60 bg-surface/50 p-4">
                          <AlertTriangle size={16} className={`mt-0.5 shrink-0 ${w.severity === 'critical' ? 'text-danger' : 'text-warning'}`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-[14px] font-medium text-text">{w.message}</div>
                            <div className="mt-1 text-[12px] text-muted">{formatTime(w.timestamp)}</div>
                          </div>
                          {w.acknowledged ? (
                            <Badge tone="success"><Check size={12} className="mr-1" /> Ack'd</Badge>
                          ) : (
                            <Button variant="ghost" className="!py-1.5 !px-4 !text-[13px] border border-border/50" onClick={() => void acknowledge(w)}>Acknowledge</Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Collapsible live monitoring feed */}
                <div className="rounded-xl border border-border/50 p-4">
                  <button
                    className="flex w-full items-center gap-2 text-[13px] font-semibold uppercase tracking-widest text-muted hover:text-text transition"
                    onClick={() => setFeedOpen((v) => !v)}
                    aria-expanded={feedOpen}
                  >
                    {feedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <ListChecks size={16} /> Live Monitoring Log
                    <span className="ml-2 flex h-5 items-center rounded-md bg-surface-2 px-2 text-[11px] text-text">
                      {feed.length} EVENTS
                    </span>
                  </button>
                  {feedOpen && (
                    <div className="mt-4 border-t border-border/50 pt-4">
                      {feed.length === 0 ? (
                        <EmptyState>No monitoring events yet.</EmptyState>
                      ) : (
                        <div className="max-h-80 space-y-1 overflow-y-auto text-mono text-[12px]">
                          {feed.slice(0, 80).map((e) => (
                            <div key={e.id} className="flex items-center gap-3 rounded hover:bg-surface-2/50 px-2 py-1.5 text-muted transition">
                              <span className="w-16 shrink-0 font-medium">{formatTime(e.serverTs)}</span>
                              <span className="w-24 shrink-0 truncate font-semibold text-text/80">{e.country}</span>
                              <span className="truncate flex-1">{e.appName ?? '—'}</span>
                              <div className="flex items-center gap-2 shrink-0">
                                {e.matchedRuleName && <Badge tone="danger">{e.matchedRuleName}</Badge>}
                                {e.type === 'away' && e.durationMs && <Badge tone="warning">away {formatDuration(e.durationMs)}</Badge>}
                                {e.type === 'return' && e.durationMs && <Badge tone="neutral">back {formatDuration(e.durationMs)}</Badge>}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
        </Card>
      </div>
      {/* ── Disable / Silence Delegate Modal ───────────────────────── */}
      {disablingDelegate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 select-none">
          <div className="relative w-full max-w-lg overflow-hidden rounded-3xl border-2 border-amber-500/40 bg-gradient-to-b from-slate-900 via-slate-950 to-black p-6 text-slate-100 shadow-2xl shadow-amber-950/50">
            <div className="flex items-center gap-3 border-b border-amber-500/20 pb-4 mb-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-400">
                <ShieldOff size={20} />
              </div>
              <div>
                <h3 className="font-serif text-lg font-bold uppercase tracking-wider text-amber-100">
                  Silence &amp; Disable Delegate
                </h3>
                <p className="text-xs font-serif italic text-amber-500/80">
                  Issuing Decree for Delegation: <span className="font-bold text-amber-200">{disablingDelegate.country}</span>
                </p>
              </div>
            </div>

            <div className="space-y-4 mb-6">
              <div>
                <label className="block font-serif text-xs font-semibold uppercase tracking-widest text-amber-400/80 mb-2">
                  Select Preset Decree
                </label>
                <div className="flex flex-wrap gap-2">
                  {[
                    "YOU'VE BEEN GAGGED",
                    "SHOULDN'T'VE DONE THAT",
                    "BY DECREE OF THE CHAIR, BE SILENT",
                    "ORDER IN THE COMMITTEE",
                    "DELEGATION DISCIPLINED",
                  ].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setDisableReason(preset)}
                      className={`rounded-xl border px-3 py-1.5 font-serif text-xs font-bold uppercase tracking-wide transition ${
                        disableReason === preset
                          ? 'border-amber-400 bg-amber-500/20 text-amber-200 shadow-sm shadow-amber-500/30'
                          : 'border-slate-800 bg-slate-900/80 text-slate-400 hover:border-amber-500/40 hover:text-slate-200'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block font-serif text-xs font-semibold uppercase tracking-widest text-amber-400/80 mb-1.5">
                  Or Custom Decree Comment
                </label>
                <textarea
                  value={disableReason}
                  onChange={(e) => setDisableReason(e.target.value)}
                  placeholder="ENTER DECREE COMMENT..."
                  rows={2}
                  className="w-full rounded-2xl border border-amber-500/30 bg-slate-950 p-3.5 font-serif text-sm font-bold uppercase tracking-wide text-amber-100 placeholder:text-slate-600 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400/50"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-4 border-t border-amber-500/20">
              <button
                type="button"
                onClick={() => setDisablingDelegate(null)}
                className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 font-serif text-xs font-semibold uppercase tracking-wider text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDisable()}
                className="rounded-xl border border-amber-400/50 bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-slate-950 px-5 py-2.5 font-serif text-xs font-bold uppercase tracking-widest shadow-lg shadow-amber-950/60 transition active:scale-95"
              >
                Enforce Decree
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
