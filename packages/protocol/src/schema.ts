/**
 * @mun/protocol — Zod validation schemas
 *
 * These schemas mirror the TypeScript types in this package and are the
 * enforcement layer at trust boundaries:
 *  - Server validates every inbound REST body and WebSocket payload.
 *  - Client validates every inbound server→client payload before use.
 *
 * Enum schemas are suffixed `*Schema` to avoid colliding with the type unions of
 * the same name (Role, VoteChoice, …) re-exported from the barrel.
 */

import { z } from 'zod';

// ─── Primitives ───────────────────────────────────────────────────────────────

export const uuid = z.string().uuid();
export const ts = z.number().int().nonnegative(); // ms since epoch
export const nonEmpty = z.string().min(1).max(512);
export const appName = z.string().min(1).max(256).nullable();
export const titleField = z.string().min(1).max(1024).nullable();

// ─── Enums ────────────────────────────────────────────────────────────────────

export const RoleSchema = z.enum(['delegate', 'chair', 'admin']);
export const CommitteeStatusSchema = z.enum(['active', 'paused', 'break', 'emergency_stopped']);
export const AttendanceSchema = z.enum([
  'not_checked_in',
  'present',
  'voting',
  'absent',
]);
export const ConnectionStatusSchema = z.enum([
  'never_connected',
  'connected',
  'disconnected',
  'reconnecting',
]);
export const SeveritySchema = z.enum(['info', 'warning', 'critical']);
export const MonitoringEventTypeSchema = z.enum([
  'focus_change',
  'away',
  'return',
  'ai_detected',
  'unexpected_app',
  'idle',
  'session_start',
  'session_end',
]);
export const WarningTypeSchema = z.enum([
  'ai_detected',
  'unexpected_app',
  'away',
  'disconnected',
  'relogin_request',
  'duplicate_login_attempt',
]);
export const VoteStatusSchema = z.enum(['open', 'closed', 'revealed']);
export const VoteChoiceSchema = z.enum(['for', 'against']);
export const BreakStatusSchema = z.enum(['scheduled', 'active', 'ended', 'cancelled']);
export const TitleScopeSchema = z.enum(['none', 'app_only', 'matched', 'self']);
export const RulePlatformSchema = z.enum(['windows', 'macos', 'all']);
export const RulePatternTypeSchema = z.enum(['contains', 'equals', 'regex']);
export const RuleMatchFieldSchema = z.enum(['app', 'title', 'app_or_title']);

// ─── Domain objects ───────────────────────────────────────────────────────────

export const UserSchema = z.object({
  id: uuid,
  username: nonEmpty,
  role: RoleSchema,
  displayName: nonEmpty,
  createdAt: ts,
});

export const CommitteeSchema = z.object({
  id: uuid,
  name: nonEmpty,
  topic: nonEmpty.max(256),
  description: z.string().max(2048),
  status: CommitteeStatusSchema,
  chairUserId: uuid.nullable(),
  createdAt: ts,
  rev: z.number().int().nonnegative(),
});

export const DelegateSchema = z.object({
  id: uuid,
  userId: uuid,
  committeeId: uuid,
  country: nonEmpty.max(128),
  attendance: AttendanceSchema,
  connectionStatus: ConnectionStatusSchema,
  lastHeartbeatAt: ts.nullable(),
  enabled: z.boolean(),
  disabledReason: z.string().max(512).nullable().optional(),
  reloginRequested: z.boolean(),
  createdAt: ts,
});

export const WarningSchema = z.object({
  id: uuid,
  committeeId: uuid,
  delegateId: uuid,
  type: WarningTypeSchema,
  severity: SeveritySchema,
  message: nonEmpty.max(1024),
  ruleId: uuid.nullable(),
  appName: appName,
  timestamp: ts,
  acknowledged: z.boolean(),
  acknowledgedBy: uuid.nullable(),
  acknowledgedAt: ts.nullable(),
});

export const VoteSchema = z.object({
  id: uuid,
  committeeId: uuid,
  question: nonEmpty.max(512),
  status: VoteStatusSchema,
  createdBy: uuid,
  createdAt: ts,
  closedAt: ts.nullable(),
  revealedAt: ts.nullable(),
  requiredCount: z.number().int().nonnegative(),
  submittedCount: z.number().int().nonnegative(),
});

export const VoteRecordSchema = z.object({
  voteId: uuid,
  delegateId: uuid,
  choice: VoteChoiceSchema.nullable(),
  submittedAt: ts,
  receipt: z.string().min(1),
  signature: z.string().min(1),
});

export const VoteResultSchema = z.object({
  voteId: uuid,
  forCount: z.number().int().nonnegative(),
  againstCount: z.number().int().nonnegative(),
  requiredCount: z.number().int().nonnegative(),
  submittedCount: z.number().int().nonnegative(),
  records: z.array(VoteRecordSchema),
  revealedAt: ts.nullable(),
});

export const ScheduledBreakSchema = z.object({
  id: uuid,
  committeeId: uuid,
  startAt: ts,
  endAt: ts,
  status: BreakStatusSchema,
  label: nonEmpty.max(128),
});

export const AiDetectionRuleSchema = z.object({
  id: uuid,
  name: nonEmpty.max(128),
  platform: RulePlatformSchema,
  matchField: RuleMatchFieldSchema,
  patternType: RulePatternTypeSchema,
  pattern: nonEmpty.max(512),
  enabled: z.boolean(),
  severity: SeveritySchema,
  category: nonEmpty.max(64),
  createdAt: ts,
  updatedAt: ts,
});

// ─── Monitoring events ────────────────────────────────────────────────────────

export const MonitoringEventWireSchema = z.object({
  clientEventId: uuid,
  delegateId: uuid,
  committeeId: uuid,
  type: MonitoringEventTypeSchema,
  clientTs: ts,
  appName: appName,
  title: titleField,
  titleScope: TitleScopeSchema,
  matchedRuleId: uuid.nullable(),
  matchedRuleName: z.string().max(128).nullable(),
  severity: SeveritySchema,
  durationMs: z.number().int().nonnegative().nullable(),
  fromAppName: appName,
});

export const MonitoringEventBroadcastSchema = z.object({
  id: uuid,
  delegateId: uuid,
  committeeId: uuid,
  delegateDisplayName: nonEmpty,
  country: nonEmpty,
  type: MonitoringEventTypeSchema,
  serverTs: ts,
  clientTs: ts,
  appName: appName,
  title: titleField,
  titleScope: TitleScopeSchema,
  matchedRuleId: uuid.nullable(),
  matchedRuleName: z.string().max(128).nullable(),
  severity: SeveritySchema,
  durationMs: z.number().int().nonnegative().nullable(),
  fromAppName: appName,
});

export const DelegateStatusBroadcastSchema = z.object({
  delegateId: uuid,
  committeeId: uuid,
  connectionStatus: ConnectionStatusSchema,
  attendance: AttendanceSchema,
  enabled: z.boolean(),
  lastHeartbeatAt: ts.nullable(),
  currentAppName: appName,
  away: z.boolean(),
  flagged: z.boolean(),
  updatedAt: ts,
});

// ─── Auth (REST) ──────────────────────────────────────────────────────────────

export const LoginRequestSchema = z.object({
  username: nonEmpty.max(128),
  password: z.string().min(1).max(256),
  platform: z.enum(['windows', 'macos']).optional().default('windows'),
  clientVersion: z.string().max(64).optional().default('0.0.0'),
  /** Stable client-generated device id (UUID). Server generates one if absent. */
  deviceId: uuid.optional(),
});

export const LoginResponseSchema = z.object({
  user: UserSchema,
  delegate: DelegateSchema.nullable(),
  committees: z.array(CommitteeSchema),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
  monitoringActive: z.boolean(),
  rules: z.array(AiDetectionRuleSchema),
});

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

// ─── Inferred response types ──────────────────────────────────────────────────

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ─── WebSocket payloads ───────────────────────────────────────────────────────

export const HelloPayloadSchema = z.object({
  accessToken: z.string().min(1),
  platform: z.enum(['windows', 'macos']),
  clientVersion: z.string().max(64),
});

export const HeartbeatPayloadSchema = z.object({
  clientTs: ts,
  monitoringActive: z.boolean(),
});

export const CastVotePayloadSchema = z.object({
  voteId: uuid,
  choice: VoteChoiceSchema,
  signature: z.string().min(1),
  publicKey: z.string().min(1),
  clientCastId: uuid,
});

export const SubscribeCommitteePayloadSchema = z.object({
  committeeId: uuid,
});

export const RequestReloginPayloadSchema = z.object({
  reason: z.string().max(512),
});

// ─── Envelope ─────────────────────────────────────────────────────────────────

export const EnvelopeShapeSchema = z.object({
  v: z.literal(1),
  t: z.string().min(1),
  id: z.string().optional(),
  ref: z.string().optional(),
  ts: ts,
  payload: z.unknown(),
});

// ─── Submissions ──────────────────────────────────────────────────────────────

export const SubmissionTypeSchema = z.enum(['resolution', 'directive']);
export const SubmissionKindSchema = z.enum(['file', 'link']);
export const SubmissionStatusSchema = z.enum(['submitted', 'reviewed']);

export const SubmissionSchema = z.object({
  id: uuid,
  committeeId: uuid,
  delegateId: uuid,
  delegateName: nonEmpty,
  country: nonEmpty,
  type: SubmissionTypeSchema,
  title: nonEmpty.max(256),
  kind: SubmissionKindSchema,
  fileName: z.string().max(256).nullable(),
  url: z.string().max(2048).nullable(),
  status: SubmissionStatusSchema,
  submittedAt: ts,
  reviewedAt: ts.nullable(),
  reviewedBy: uuid.nullable(),
});

export const SubmissionLinkRequestSchema = z.object({
  type: SubmissionTypeSchema,
  title: nonEmpty.max(256),
  url: z.string().url().max(2048),
});

// ─── Validation helpers ───────────────────────────────────────────────────────

/** Parse strictly; throw a zod-friendly error on failure. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

/** Safe parse returning a typed result without throwing. */
export function safeParse<T>(schema: z.ZodType<T>, value: unknown):
  | { success: true; data: T }
  | { success: false; error: z.ZodError } {
  const r = schema.safeParse(value);
  return r.success ? { success: true, data: r.data } : { success: false, error: r.error };
}

/** Format zod issues into the ApiError.details shape. */
export function formatZodIssues(error: z.ZodError): Array<{ field: string; issue: string }> {
  return error.issues.map((i) => ({ field: i.path.join('.'), issue: i.message }));
}
