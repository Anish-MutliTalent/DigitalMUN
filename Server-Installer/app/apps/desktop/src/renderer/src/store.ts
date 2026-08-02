/**
 * @mun/desktop renderer — central state store (Zustand)
 *
 * One store holds auth, connection, monitoring, and all realtime-derived state
 * (presence, monitoring feed, warnings, votes, re-login requests, system
 * health). App.tsx subscribes to the push channels and dispatches into the
 * store; components read from it reactively.
 */

import { create } from 'zustand';
import { api } from './api';
import type {
  ServerEnvelope,
  User,
  Delegate,
  Committee,
  AiDetectionRule,
  Warning,
  MonitoringEventBroadcast,
  DelegateStatusBroadcast,
  Vote,
  VoteResult,
  ScheduledBreak,
  ReloginUpdatePayload,
  SystemHealth,
  VoteCastAckPayload,
  Submission,
  SubmissionType,
} from '@mun/protocol';
import type { ConnectionInfo, MonitoringState, PersistedState, LoginResult } from '@shared/ipc';
import type { VoteChoice } from '@mun/protocol';

const MAX_FEED = 500;
const MAX_WARNINGS = 500;

export interface ReloginRequest extends ReloginUpdatePayload {}

interface MunState {
  // auth
  user: User | null;
  delegate: Delegate | null;
  committees: Committee[];
  rules: AiDetectionRule[];
  serverUrl: string;
  hydrated: boolean;
  // connection / monitoring
  connection: ConnectionInfo | null;
  monitoring: MonitoringState | null;
  platform: 'windows' | 'macos';
  // realtime committee state
  currentCommittee: Committee | null;
  delegates: Delegate[];
  delegateStatus: Record<string, DelegateStatusBroadcast>;
  votes: Vote[];
  voteResults: Record<string, VoteResult | null>;
  activeBreak: ScheduledBreak | null;
  monitoringFeed: MonitoringEventBroadcast[];
  warnings: Warning[];
  reloginRequests: ReloginRequest[];
  systemHealth: SystemHealth | null;
  pendingCastAck: VoteCastAckPayload | null;
  submissions: Submission[];
  // toasts
  toast: { kind: 'info' | 'success' | 'warning' | 'error'; message: string } | null;

  // actions
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<LoginResult>;
  join: (committeeId: string, country: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  castVote: (voteId: string, choice: VoteChoice) => Promise<VoteCastAckPayload>;
  setServerUrl: (url: string) => Promise<void>;
  // submissions
  refreshSubmissions: (committeeId: string) => Promise<void>;
  submitLink: (type: SubmissionType, title: string, url: string) => Promise<{ ok: boolean; error?: string }>;
  submitFile: (type: SubmissionType, title: string, filePath: string) => Promise<{ ok: boolean; error?: string }>;
  pickFile: () => Promise<{ path: string; name: string } | null>;
  markSubmissionReviewed: (id: string) => Promise<void>;
  deleteSubmission: (id: string) => Promise<void>;
  openSubmissionFile: (id: string, fileName: string) => Promise<void>;
  openSubmissionLink: (url: string) => Promise<void>;
  dispatchEvent: (env: ServerEnvelope) => void;
  setConnection: (info: ConnectionInfo) => void;
  setMonitoring: (state: MonitoringState) => void;
  setToast: (toast: MunState['toast']) => void;
  clearToast: () => void;
}

export const useStore = create<MunState>((set, get) => ({
  user: null,
  delegate: null,
  committees: [],
  rules: [],
  serverUrl: '',
  hydrated: false,
  connection: null,
  monitoring: null,
  platform: 'windows',
  currentCommittee: null,
  delegates: [],
  delegateStatus: {},
  votes: [],
  voteResults: {},
  activeBreak: null,
  monitoringFeed: [],
  warnings: [],
  reloginRequests: [],
  systemHealth: null,
  pendingCastAck: null,
  submissions: [],
  toast: null,

  bootstrap: async () => {
    const state = (await api.getState()) as PersistedState;
    const platform = await api.getPlatform();
    const connection = await api.getConnection();
    set({
      user: state.user,
      delegate: state.delegate,
      committees: state.committees,
      rules: state.rules,
      serverUrl: state.serverUrl,
      platform,
      connection,
      hydrated: true,
    });
    // If a session was restored, the backend already reconnected; refresh connection.
    if (state.user) {
      void get().setConnection(await api.getConnection());
    }
  },

  login: async (username, password) => {
    const result = await api.login(username, password);
    if (result.ok && result.response) {
      const r = result.response;
      set({
        user: r.user,
        delegate: r.delegate,
        committees: r.committees,
        rules: r.rules,
        currentCommittee: r.committees[0] ?? null,
        connection: await api.getConnection(),
      });
    } else if (result.reloginRequired) {
      set({ toast: { kind: 'warning', message: result.message ?? 'Re-login required' } });
    } else if (result.error) {
      set({ toast: { kind: 'error', message: result.error } });
    }
    return result;
  },

  join: async (committeeId, country) => {
    const result = await api.join(committeeId, country);
    if (result.ok && result.response) {
      const r = result.response;
      set({
        user: r.user,
        delegate: r.delegate,
        committees: r.committees,
        rules: r.rules,
        currentCommittee: r.committees[0] ?? null,
        connection: await api.getConnection(),
      });
    } else if (result.reloginRequired) {
      set({ toast: { kind: 'warning', message: result.message ?? 'Re-login required' } });
    } else if (result.error) {
      set({ toast: { kind: 'error', message: result.error } });
    }
    return result;
  },

  logout: async () => {
    await api.logout();
    set({
      user: null,
      delegate: null,
      committees: [],
      currentCommittee: null,
      delegates: [],
      delegateStatus: {},
      votes: [],
      voteResults: {},
      monitoringFeed: [],
      warnings: [],
      reloginRequests: [],
      monitoring: null,
    });
  },

  castVote: async (voteId, choice) => {
    const ack = await api.castVote(voteId, choice);
    set({ pendingCastAck: ack });
    if (ack.accepted) {
      set({ toast: { kind: 'success', message: 'Vote submitted.' } });
    } else if (ack.reason) {
      set({ toast: { kind: 'warning', message: ack.reason } });
    }
    return ack;
  },

  setServerUrl: async (url) => {
    await api.setServerUrl(url);
    set({ serverUrl: url });
  },

  refreshSubmissions: async (committeeId) => {
    const submissions = await api.listSubmissions(committeeId);
    set({ submissions });
  },

  submitLink: async (type, title, url) => {
    const cid = get().currentCommittee?.id;
    if (!cid) return { ok: false, error: 'No committee.' };
    const r = await api.submitLinkSubmission(cid, type, title, url);
    if (!r.ok) set({ toast: { kind: 'error', message: r.error ?? 'Submission failed' } });
    else set({ toast: { kind: 'success', message: 'Submitted.' } });
    return r;
  },

  submitFile: async (type, title, filePath) => {
    const cid = get().currentCommittee?.id;
    if (!cid) return { ok: false, error: 'No committee.' };
    const r = await api.submitFileSubmission(cid, type, title, filePath);
    if (!r.ok) set({ toast: { kind: 'error', message: r.error ?? 'Upload failed' } });
    else set({ toast: { kind: 'success', message: 'Submitted.' } });
    return r;
  },

  pickFile: async () => {
    return api.pickFile();
  },

  markSubmissionReviewed: async (id) => {
    const cid = get().currentCommittee?.id;
    if (!cid) return;
    await api.markSubmissionReviewed(cid, id);
  },

  deleteSubmission: async (id) => {
    const cid = get().currentCommittee?.id;
    if (!cid) return;
    await api.deleteSubmission(cid, id);
    set((s) => ({ submissions: s.submissions.filter((x) => x.id !== id) }));
  },

  openSubmissionFile: async (id, fileName) => {
    const cid = get().currentCommittee?.id;
    if (!cid) return;
    await api.openSubmissionFile(cid, id, fileName);
  },

  openSubmissionLink: async (url) => {
    await api.openSubmissionLink(url);
  },

  setConnection: (info) => set({ connection: info }),
  setMonitoring: (state) => set({ monitoring: state }),
  setToast: (toast) => set({ toast }),
  clearToast: () => set({ toast: null }),

  dispatchEvent: (env) => {
    switch (env.t) {
      case 'welcome': {
        const p = env.payload as unknown as {
          user: User;
          committees: Committee[];
          delegate: Delegate | null;
        };
        set({
          user: p.user,
          committees: p.committees,
          delegate: p.delegate,
          currentCommittee: p.committees[0] ?? get().currentCommittee,
        });
        break;
      }
      case 'committee_state': {
        const p = env.payload as {
          committee: Committee;
          delegates: Delegate[];
          votes: Vote[];
          activeBreak: ScheduledBreak | null;
        };
        set({
          currentCommittee: p.committee,
          delegates: p.delegates,
          votes: p.votes,
          activeBreak: p.activeBreak,
        });
        break;
      }
      case 'delegate_status': {
        const p = env.payload as DelegateStatusBroadcast;
        set((s) => ({ delegateStatus: { ...s.delegateStatus, [p.delegateId]: p } }));
        break;
      }
      case 'monitor_broadcast': {
        const p = env.payload as MonitoringEventBroadcast;
        set((s) => ({ monitoringFeed: [p, ...s.monitoringFeed].slice(0, MAX_FEED) }));
        break;
      }
      case 'warning': {
        const p = (env.payload as { warning: Warning }).warning;
        set((s) => ({ warnings: [p, ...s.warnings.filter((w) => w.id !== p.id)].slice(0, MAX_WARNINGS) }));
        break;
      }
      case 'warning_acked': {
        const p = env.payload as { warningId: string; by: string; at: number };
        set((s) => ({
          warnings: s.warnings.map((w) =>
            w.id === p.warningId ? { ...w, acknowledged: true, acknowledgedBy: p.by, acknowledgedAt: p.at } : w,
          ),
        }));
        break;
      }
      case 'vote_state': {
        const p = env.payload as { vote: Vote; result: VoteResult | null };
        set((s) => ({
          votes: [p.vote, ...s.votes.filter((v) => v.id !== p.vote.id)],
          voteResults: { ...s.voteResults, [p.vote.id]: p.result },
        }));
        break;
      }
      case 'vote_cast_ack': {
        const p = env.payload as VoteCastAckPayload;
        set({ pendingCastAck: p });
        break;
      }
      case 'vote_revealed': {
        const p = env.payload as { vote: Vote; result: VoteResult };
        set((s) => ({
          votes: s.votes.map((v) => (v.id === p.vote.id ? p.vote : v)),
          voteResults: { ...s.voteResults, [p.vote.id]: p.result },
        }));
        break;
      }
      case 'break_state': {
        const p = env.payload as { break: ScheduledBreak | null };
        set({ activeBreak: p.break });
        break;
      }
      case 'relogin_update': {
        const p = env.payload as ReloginUpdatePayload;
        set((s) => ({
          reloginRequests: [p, ...s.reloginRequests.filter((r) => r.requestId !== p.requestId)].slice(0, 100),
        }));
        break;
      }
      case 'system_health': {
        set({ systemHealth: env.payload as SystemHealth });
        break;
      }
      case 'rules_updated': {
        set({ rules: (env.payload as { rules: AiDetectionRule[] }).rules });
        break;
      }
      case 'submission':
      case 'submission_update': {
        const sub = (env.payload as { submission: Submission }).submission;
        set((s) => ({
          submissions: [sub, ...s.submissions.filter((x) => x.id !== sub.id)],
        }));
        break;
      }
      case 'force_logout': {
        const p = env.payload as { reason: string };
        set({
          user: null,
          delegate: null,
          toast: { kind: 'error', message: `Forced logout: ${p.reason}` },
        });
        break;
      }
      case 'monitoring_paused': {
        // connection.monitoring reflects this via the main process push.
        break;
      }
      default:
        break;
    }
  },
}));
