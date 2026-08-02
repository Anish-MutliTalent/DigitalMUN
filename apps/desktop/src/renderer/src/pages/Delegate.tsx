/**
 * @mun/desktop renderer — Delegate screen
 *
 * Designed to match the SAFE MUN 2026 reference UI pixel-for-pixel:
 * - Delegate Details card with icon-labelled metadata rows & pill badges
 * - Dark Active Vote card with ballot-box empty state & cryptographic voting
 * - Past Votes timeline with circular gavel icons
 * - Submission card for Resolutions/Directives with Upload/Link toggle
 */

import { useState, useEffect } from 'react';
import {
  Activity,
  CheckCircle2,
  Clock,
  ThumbsDown,
  ThumbsUp,
  AlertTriangle,
  FileText,
  FileUp,
  ExternalLink,
  Trash2,
  Users,
  Flag,
  UserCheck,
  Gavel,
  Send,
  Link as LinkIcon,
  Upload,
  Vote as VoteIcon,
} from 'lucide-react';
import { useStore } from '../store';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  SectionTitle,
  Select,
  formatTime,
} from '../components/ui';
import type { Vote } from '@mun/protocol';

/* ─── Country → flag emoji helper ────────────────────────────────────────────── */
function countryFlag(country: string): string {
  const COUNTRY_FLAGS: Record<string, string> = {
    afghanistan: '🇦🇫', albania: '🇦🇱', algeria: '🇩🇿', argentina: '🇦🇷',
    australia: '🇦🇺', austria: '🇦🇹', bangladesh: '🇧🇩', belgium: '🇧🇪',
    brazil: '🇧🇷', canada: '🇨🇦', chile: '🇨🇱', china: '🇨🇳',
    colombia: '🇨🇴', cuba: '🇨🇺', denmark: '🇩🇰', egypt: '🇪🇬',
    ethiopia: '🇪🇹', finland: '🇫🇮', france: '🇫🇷', germany: '🇩🇪',
    ghana: '🇬🇭', greece: '🇬🇷', india: '🇮🇳', indonesia: '🇮🇩',
    iran: '🇮🇷', iraq: '🇮🇶', ireland: '🇮🇪', israel: '🇮🇱',
    italy: '🇮🇹', jamaica: '🇯🇲', japan: '🇯🇵', jordan: '🇯🇴',
    kenya: '🇰🇪', mexico: '🇲🇽', morocco: '🇲🇦', netherlands: '🇳🇱',
    'new zealand': '🇳🇿', nigeria: '🇳🇬', norway: '🇳🇴', pakistan: '🇵🇰',
    peru: '🇵🇪', philippines: '🇵🇭', poland: '🇵🇱', portugal: '🇵🇹',
    qatar: '🇶🇦', romania: '🇷🇴', russia: '🇷🇺', 'russian federation': '🇷🇺',
    'saudi arabia': '🇸🇦', 'south africa': '🇿🇦', 'south korea': '🇰🇷',
    'republic of korea': '🇰🇷', spain: '🇪🇸', sweden: '🇸🇪',
    switzerland: '🇨🇭', syria: '🇸🇾', thailand: '🇹🇭', turkey: '🇹🇷',
    'türkiye': '🇹🇷', ukraine: '🇺🇦', 'united arab emirates': '🇦🇪',
    'united kingdom': '🇬🇧', 'united states': '🇺🇸',
    'united states of america': '🇺🇸', uruguay: '🇺🇾', venezuela: '🇻🇪',
    vietnam: '🇻🇳',
  };
  return COUNTRY_FLAGS[country.toLowerCase()] ?? '🏳️';
}

export function DelegateScreen() {
  const delegate = useStore((s) => s.delegate);
  const committee = useStore((s) => s.currentCommittee);
  const monitoring = useStore((s) => s.monitoring);
  const votes = useStore((s) => s.votes);
  const voteResults = useStore((s) => s.voteResults);
  const pendingAck = useStore((s) => s.pendingCastAck);
  const castVote = useStore((s) => s.castVote);

  const [voting, setVoting] = useState<string | null>(null);
  const [voted, setVoted] = useState<Set<string>>(new Set());

  const openVote = votes.find((v) => v.status === 'open');
  const pastVotes = votes.filter((v) => v.status !== 'open');

  async function doVote(v: Vote, choice: 'for' | 'against') {
    setVoting(v.id);
    await castVote(v.id, choice);
    setVoted((s) => new Set([...s, v.id]));
    setVoting(null);
  }

  if (!delegate || !committee) {
    return <EmptyState>You are not assigned to a committee.</EmptyState>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {/* Integrity flag banner */}
      {monitoring?.flagged && (
        <div className="flex items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50/80 px-4 py-3 text-sm text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertTriangle size={16} className="shrink-0" />
          <span>
            An integrity rule flagged{' '}
            <strong>{monitoring.currentAppName ?? 'the current app'}</strong>.
            The chair has been notified.
          </span>
        </div>
      )}

      {/* ─── Top Grid: DELEGATE DETAILS + ACTIVE VOTE ─────────────────────── */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[3fr_2fr]">

        {/* ── Delegate Details ─────────────────────────────────────────────── */}
        <Card>
          <SectionTitle underline={false}>Delegate Details</SectionTitle>
          <dl className="text-sm">
            {/* COMMITTEE */}
            <div className="flex items-center justify-between border-b border-border/40 py-3 first:pt-0">
              <dt className="flex items-center gap-3 text-muted">
                <Users size={16} className="shrink-0" />
                <span className="text-xs font-medium uppercase tracking-wider">Committee</span>
              </dt>
              <dd className="text-right font-medium text-text">{committee.name}</dd>
            </div>

            {/* TOPIC */}
            <div className="flex items-center justify-between border-b border-border/40 py-3">
              <dt className="flex items-center gap-3 text-muted">
                <FileText size={16} className="shrink-0" />
                <span className="text-xs font-medium uppercase tracking-wider">Topic</span>
              </dt>
              <dd
                className="max-w-[55%] text-right font-medium text-text"
                title={committee.topic}
              >
                {committee.topic}
              </dd>
            </div>

            {/* YOUR COUNTRY */}
            <div className="flex items-center justify-between border-b border-border/40 py-3">
              <dt className="flex items-center gap-3 text-muted">
                <Flag size={16} className="shrink-0" />
                <span className="text-xs font-medium uppercase tracking-wider">Your Country</span>
              </dt>
              <dd className="flex items-center gap-1.5 font-medium text-text">
                {delegate.country} {countryFlag(delegate.country)}
              </dd>
            </div>

            {/* ATTENDANCE */}
            <div className="flex items-center justify-between border-b border-border/40 py-3">
              <dt className="flex items-center gap-3 text-muted">
                <UserCheck size={16} className="shrink-0" />
                <span className="text-xs font-medium uppercase tracking-wider">Attendance</span>
              </dt>
              <dd>
                <Badge
                  tone={
                    delegate.attendance === 'present' || delegate.attendance === 'voting'
                      ? 'success'
                      : 'neutral'
                  }
                >
                  {delegate.attendance === 'present'
                    ? 'Present'
                    : delegate.attendance === 'voting'
                      ? 'Present & Voting'
                      : 'Not Checked In'}
                </Badge>
              </dd>
            </div>

            {/* STATUS */}
            <div className="flex items-center justify-between py-3">
              <dt className="flex items-center gap-3 text-muted">
                <Activity size={16} className="shrink-0" />
                <span className="text-xs font-medium uppercase tracking-wider">Status</span>
              </dt>
              <dd>
                <Badge tone={committee.status === 'active' ? 'success' : 'warning'}>
                  {committee.status === 'active' ? 'Active' : 'Inactive'}
                </Badge>
              </dd>
            </div>
          </dl>
        </Card>

        {/* ── Active Vote (Dark Card) ──────────────────────────────────────── */}
        <Card variant="dark" className="flex flex-col">
          <SectionTitle
            underlineClass="bg-stone-600"
          >
            <span className="text-white/90">Active Vote</span>
          </SectionTitle>

          {!openVote ? (
            /* Empty state */
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6">
              <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-[#2A2B30] text-stone-400">
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 8h14l1 12H4L5 8z" />
                  <path d="M3 8V5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3" />
                  <path d="M12 12v3" />
                  <path d="M10 12h4" />
                </svg>
              </div>
              <div className="text-center">
                <div className="text-lg font-medium text-white">No active vote</div>
                <div className="mt-0.5 text-sm text-stone-500">
                  The chair will open one when ready.
                </div>
              </div>
            </div>
          ) : (
            /* Live vote */
            <div className="flex flex-1 flex-col justify-between gap-4 pt-2">
              <div>
                <div className="text-base font-medium leading-snug text-white">
                  {openVote.question}
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-stone-500">
                  <span className="inline-flex items-center gap-1">
                    <Activity size={12} /> {openVote.submittedCount}/{openVote.requiredCount}{' '}
                    submitted
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock size={12} /> opened {formatTime(openVote.createdAt)}
                  </span>
                </div>
              </div>

              {voted.has(openVote.id) ||
              (pendingAck?.voteId === openVote.id && pendingAck.accepted) ? (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/40 p-3 text-sm text-emerald-300">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={16} />
                    Your vote was recorded.
                  </div>
                  {pendingAck?.receipt && (
                    <details className="mt-2 text-xs text-stone-400">
                      <summary className="cursor-pointer hover:text-stone-200">
                        View receipt
                      </summary>
                      <pre className="mt-1 break-all whitespace-pre-wrap rounded-lg bg-stone-900 p-2 font-mono text-[11px] text-stone-500 border border-stone-800">
                        {pendingAck.receipt}
                      </pre>
                    </details>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => doVote(openVote, 'for')}
                    disabled={voting === openVote.id}
                    className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 active:scale-[0.98] disabled:opacity-50"
                  >
                    <ThumbsUp size={16} /> FOR
                  </button>
                  <button
                    onClick={() => doVote(openVote, 'against')}
                    disabled={voting === openVote.id}
                    className="flex items-center justify-center gap-2 rounded-xl bg-rose-600 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-500 active:scale-[0.98] disabled:opacity-50"
                  >
                    <ThumbsDown size={16} /> AGAINST
                  </button>
                </div>
              )}

              <p className="text-[11px] text-stone-500">
                Results are hidden until every enabled delegate has voted. Your vote
                is signed with your device key and is cryptographically verifiable.
              </p>
            </div>
          )}
        </Card>
      </div>

      {/* ─── PAST VOTES ──────────────────────────────────────────────────── */}
      <Card>
        <SectionTitle>Past Votes</SectionTitle>
        {pastVotes.length === 0 ? (
          <EmptyState>No past votes yet.</EmptyState>
        ) : (
          <div className="space-y-1">
            {pastVotes.map((v) => {
              const result = voteResults[v.id];
              return (
                <div
                  key={v.id}
                  className="flex items-center justify-between py-3"
                >
                  <div className="flex items-center gap-3">
                    {/* Circular gavel icon */}
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/80 bg-surface-2/50 text-text/70">
                      <Gavel size={17} />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-text">
                        {v.question}
                      </div>
                      <div className="mt-0.5 text-xs text-muted">
                        {formatTime(v.createdAt)} • {v.status}
                      </div>
                    </div>
                  </div>

                  {v.status === 'revealed' && result ? (
                    <div className="flex gap-2">
                      <Badge tone="success">FOR {result.forCount}</Badge>
                      <Badge tone="danger">AGAINST {result.againstCount}</Badge>
                    </div>
                  ) : (
                    <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-600 dark:bg-stone-800 dark:text-stone-400">
                      {v.submittedCount}/{v.requiredCount} — hidden
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ─── SUBMIT RESOLUTION / DIRECTIVE ────────────────────────────────── */}
      <SubmissionCard delegateId={delegate?.id ?? ''} />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────── */

function SubmissionCard({ delegateId }: { delegateId: string }) {
  const submissions = useStore((s) => s.submissions);
  const submitLink = useStore((s) => s.submitLink);
  const submitFile = useStore((s) => s.submitFile);
  const pickFile = useStore((s) => s.pickFile);
  const deleteSubmission = useStore((s) => s.deleteSubmission);
  const openSubmissionFile = useStore((s) => s.openSubmissionFile);
  const openSubmissionLink = useStore((s) => s.openSubmissionLink);
  const refreshSubmissions = useStore((s) => s.refreshSubmissions);
  const currentCommittee = useStore((s) => s.currentCommittee);

  const [type, setType] = useState<'resolution' | 'directive'>('resolution');
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'file' | 'link'>('file');
  const [url, setUrl] = useState('');
  const [pickedFile, setPickedFile] = useState<{ path: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (currentCommittee?.id) void refreshSubmissions(currentCommittee.id);
  }, [currentCommittee?.id, refreshSubmissions]);

  const mine = submissions.filter((s) => s.delegateId === delegateId);

  async function chooseFile() {
    const f = await pickFile();
    setPickedFile(f);
  }

  async function submit() {
    if (!title.trim()) return;
    setBusy(true);
    if (mode === 'link') {
      if (!url.trim()) { setBusy(false); return; }
      await submitLink(type, title.trim(), url.trim());
      setUrl('');
    } else {
      if (!pickedFile) { setBusy(false); return; }
      await submitFile(type, title.trim(), pickedFile.path);
      setPickedFile(null);
    }
    setBusy(false);
    setTitle('');
  }

  return (
    <Card>
      <SectionTitle>Submit Resolution / Directive</SectionTitle>
      <div className="space-y-3">
        {/* Row 1: type selector + title input */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_3fr]">
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as 'resolution' | 'directive')}
          >
            <option value="resolution">Resolution</option>
            <option value="directive">Directive</option>
          </Select>
          <Input
            placeholder="Title (e.g. Draft Resolution 1.1)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Row 2: mode toggle buttons */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode('file')}
            className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-medium transition ${
              mode === 'file'
                ? 'bg-[#1C1D21] text-white dark:bg-white dark:text-black'
                : 'border border-border bg-transparent text-text hover:bg-surface-2'
            }`}
          >
            <Upload size={13} /> Upload PDF / DOC
          </button>
          <button
            type="button"
            onClick={() => setMode('link')}
            className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-medium transition ${
              mode === 'link'
                ? 'bg-[#1C1D21] text-white dark:bg-white dark:text-black'
                : 'border border-border bg-transparent text-text hover:bg-surface-2'
            }`}
          >
            <LinkIcon size={13} /> Google Doc link
          </button>
        </div>

        {/* Row 3: input + submit */}
        <div className="flex items-center gap-3">
          <div className="flex-1">
            {mode === 'link' ? (
              <Input
                placeholder="https://docs.google.com/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            ) : (
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={chooseFile} type="button" className="shrink-0">
                  <FileUp size={14} /> {pickedFile ? 'Change file' : 'Choose file'}
                </Button>
                <span className="truncate text-xs text-muted">
                  {pickedFile ? pickedFile.name : 'No file selected (PDF, DOC, or DOCX)'}
                </span>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={submit}
            disabled={busy || !title.trim() || (mode === 'link' ? !url.trim() : !pickedFile)}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-[#1C1D21] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-black active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-stone-200"
          >
            <Send size={14} />
            {busy ? 'Submitting…' : `Submit ${type}`}
          </button>
        </div>

        {/* My submissions */}
        {mine.length > 0 && (
          <div className="space-y-2 border-t border-border/40 pt-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">
              Your submissions
            </div>
            {mine.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between rounded-xl border border-border p-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-text">{s.title}</div>
                  <div className="text-xs text-muted">
                    {s.type} · {s.kind === 'file' ? s.fileName : 'link'} ·{' '}
                    {formatTime(s.submittedAt)}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge tone={s.status === 'reviewed' ? 'success' : 'warning'}>
                    {s.status}
                  </Badge>
                  {s.kind === 'file' ? (
                    <button
                      className="rounded p-1 text-muted hover:text-text"
                      title="Open"
                      onClick={() => void openSubmissionFile(s.id, s.fileName ?? 'document')}
                    >
                      <FileText size={14} />
                    </button>
                  ) : (
                    <button
                      className="rounded p-1 text-muted hover:text-text"
                      title="Open link"
                      onClick={() => void openSubmissionLink(s.url ?? '')}
                    >
                      <ExternalLink size={14} />
                    </button>
                  )}
                  <button
                    className="rounded p-1 text-muted hover:text-danger"
                    title="Delete"
                    onClick={() => void deleteSubmission(s.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
