# Architecture

## Overview

SAFE MUN 2026 is a three-tier system for a single conference venue:

```
┌────────────┐   WebSocket (realtime) + REST (auth/management)   ┌────────────┐
│  Desktop   │ ───────────────────────────────────────────────▶  │   Server   │
│  (Electron)│ ◀─────────────────────────────────────────────── │ (Fastify)  │
└────────────┘                                                   └─────┬──────┘
  delegate / chair / admin                                              │
                                                                       ▼
                                                                 ┌──────────┐
                                                                 │ Postgres │
                                                                 └──────────┘
```

- **One server process** runs on a dedicated machine at the venue (or a
  organizer laptop on the venue LAN). It is the single source of truth.
- **Desktop clients** connect over the venue network. Delegates are monitored;
  chairs and admins observe and control. Realtime target latency is <200 ms.
- **PostgreSQL** holds all persistent state and the tamper-evident audit log.

The server is a single process by design — at 500 delegates the in-process
WebSocket broker has no external pub/sub hop, keeping latency low. For larger
deployments, horizontal scaling would require an external pub/sub (Redis) and
sticky sessions; that is out of scope for the 500-delegate target.

## Packages

### `@mun/protocol`
The contract spine. Defines every domain type (`User`, `Committee`, `Delegate`,
`Vote`, `Warning`, `MonitoringEvent`, …), the WebSocket message envelope, and
Zod schemas that mirror the types. Both server and desktop import it, so the
wire format is type-checked end to end. **No runtime code beyond Zod.**

### `@mun/crypto`
Cryptographic primitives shared by server and desktop:
- Ed25519 key generation / signing / verification (raw 32/64-byte keys, base64url).
- Canonical JSON (sorted keys, no whitespace) for deterministic signing/hashing.
- Tamper-evident audit log: `hash_n = SHA-256(prevHash || canonical(fields))`.
- HMAC-SHA256 session tokens (access + refresh, single-use refresh rotation).
- Vote signing + server-signed receipts (`mun-vote:v1` / `mun-receipt:v1`).

### `apps/server`
Fastify HTTP + a raw `ws` WebSocket server on `/ws`. Subsystems:

| Module | Responsibility |
| --- | --- |
| `db/` | pg pool, migration runner, idempotent seed |
| `auth/` | Argon2id passwords, sessions, single-device enforcement, chair-approved re-login, REST routes |
| `realtime/` | in-process broker (per-committee + admin fan-out), presence/heartbeat sweep, WebSocket handler |
| `monitoring/` | idempotent event ingest, AI-warning generation, rule cache, queries/exports |
| `voting/` | vote create/cast/close/reveal, signature verification, server-signed receipts, completion-gated reveal |
| `committee/` | committee CRUD, delegate management, breaks (scheduler + auto-transition), pause/resume |
| `admin/` | emergency stop/resume, user management, system health, audit export, active sessions |
| `audit/` | append-only hash-chained log (advisory-lock-serialised appends) |

### `apps/desktop`
Electron app. **Main process** (Node, CommonJS): encrypted store (OS keychain
via `safeStorage`), auth/crypto/realtime clients, the monitoring engine, IPC.
**Preload**: a typed `window.mun` bridge (context isolation, no Node in the
renderer). **Renderer**: React + Tailwind, four screens (Login, Delegate,
Chair, Admin), Zustand store fed by realtime pushes.

## Monitoring (Priority 1)

### What is captured
Only integrity-relevant **metadata**, polled at 1 Hz and emitted **on change**
(event-driven, not a continuous stream):

- Foreground application / process name.
- Window title — **only when an integrity rule matches** or the focused app is
  SAFE MUN 2026 itself (`titleScope: matched | self`). For neutral apps the
  title is omitted (`titleScope: app_only`).
- System-wide idle time.
- Focus changes, away/return transitions.

### What is NEVER captured
Screenshots, video, microphone, webcam, keystrokes, document contents,
clipboard contents. The monitoring modules (`monitor/windows.ts`,
`monitor/macos.ts`) physically cannot read these — they call only
`GetForegroundWindow`/`GetWindowTextW`/`GetLastInputInfo` (Windows) and
System Events frontmost-app/window + `ioreg` idle (macOS).

### Windows
`koffi` (prebuilt N-API FFI) calls Win32 via `user32.dll`/`kernel32.dll`:
`GetForegroundWindow`, `GetWindowTextW`, `GetWindowThreadProcessId`,
`QueryFullProcessImageNameW`, `GetLastInputInfo`, `GetTickCount64`. The process
name is derived from the foreground window's PID.

### macOS
`osascript` queries System Events for the frontmost application process name
and its front window title. **Accessibility permission is required** (System
Settings → Privacy & Security → Accessibility); the UI surfaces this. Idle time
comes from `ioreg` (`HIDIdleTime`).

### AI detection
Rules (`ai_detection_rules` table) are matched client-side against the
foreground app name and (when available) title. The built-in seed covers
ChatGPT, Claude, Gemini, Copilot, DeepSeek, Perplexity, Grok/xAI, Meta AI,
Mistral Le Chat. **New AI services can be added by an admin at runtime via the
Admin screen → AI Rules; the rule set syncs to every delegate instantly over
WebSocket (`rules_updated`) — no app recompilation required.**

When a rule matches, the engine emits an `ai_detected` event (with the title as
evidence); the server creates a durable `Warning`, notifies the chair in real
time, and audits it.

### Breaks / pauses
When a committee is paused, on a scheduled break, or emergency-stopped, the
server broadcasts `monitoring_paused`; the desktop engine stops polling and the
delegate UI shows **STANDBY**. On resume, `monitoring_resumed` restarts the
engine. Breaks are scheduled by the chair and auto-transitioned by a server
scheduler.

## Realtime protocol

One WebSocket endpoint: `ws://host/ws`. Authentication is via a `hello` message
carrying an access token (browsers cannot set headers on WS upgrades); the
socket must `hello` within 5 s or it is closed. After `hello`, the socket is
registered with the broker on its committee channel (admins receive every
committee). Heartbeats refresh presence and re-check session validity (a revoked
session's socket is terminated even if the client ignores `force_logout`).

Messages are a typed envelope `{ v, t, id?, ref?, ts, payload }`. Full list in
`packages/protocol/src/messages.ts`.

## Authentication & sessions

- Argon2id password hashing.
- HMAC-signed access (short-lived) + refresh (long-lived) tokens. Only SHA-256
  hashes of tokens are stored, so a DB leak cannot forge tokens.
- **Single active session per delegate.** A second login while a session is
  active is blocked; the delegate must request re-login, which the chair
  approves (revoking the old session). Crashes do **not** auto-free a session.
- Chairs/admins may switch devices (prior session revoked on new login).
- Refresh tokens are single-use (rotating jti); replaying a used refresh token
  is rejected.

## Digital voting

- Chair opens a vote (FOR/AGAINST only — no abstention).
- Each delegate signs their choice with their Ed25519 private key (kept in the
  OS keychain on their device); the server verifies against the delegate's
  registered public key.
- Votes are **immutable** (DB trigger forbids UPDATE/DELETE) and **one per
  delegate** (UNIQUE constraint + row lock → race-condition-proof).
- Results are **hidden** until every enabled, checked-in delegate has voted.
  The chair sees only `submitted / required` (e.g. `18 / 24`). Reveal is gated
  on completion; disabling a non-voting delegate lowers the required count
  (the chair's escape hatch for absent delegates).
- The server returns an Ed25519-signed **receipt** so any party holding the
  server public key can later verify a recorded vote.

## Audit log

Every security-relevant action (login, re-login decisions, committee state
changes, delegate enable/disable/force-logout, vote open/close/reveal, warnings,
rule changes, exports, emergency stop) is appended to `audit_log`, an
append-only table (UPDATE/DELETE forbidden by trigger) whose rows form a SHA-256
hash chain. `verifyAuditChain()` recomputes the chain and reports the first
broken entry. The admin screen shows live verification status.

## Resilience

The desktop client is built to recover from: network drop, server restart,
sleep/wake (`powerMonitor` triggers a forced reconnect), app crash (persisted
session auto-restores), clock drift (server timestamps + heartbeat drift), and
duplicate events (client-generated idempotency keys; the server dedups via
UNIQUE constraints). The realtime client uses exponential backoff + jitter and
an offline queue that flushes on reconnect.

## Performance

500+ delegates = 500 WebSocket connections + event traffic. Event-driven
emission (only on state change) keeps bandwidth minimal. The pg pool is sized
via `PG_POOL_MAX`. Audit appends are serialised by a Postgres advisory lock
(moderate frequency; monitoring telemetry lives in a separate append-friendly
table, not the audit log).
