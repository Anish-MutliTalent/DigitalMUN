# Security & Privacy

SAFE MUN 2026 is monitoring software. Because it runs on delegates' personal
laptops, it is held to a high privacy standard. This document is the definitive
statement of what the software does and does not collect, and how it is secured.

## Data minimisation (privacy)

### What is collected
Only metadata required for committee integrity, captured at 1 Hz and emitted
on state change:

| Data | When | Purpose |
| --- | --- | --- |
| Foreground application/process name | on focus change | detect app switches, AI apps |
| Window title | **only when an AI rule matches**, or the app is SAFE MUN 2026 | evidence for an integrity warning |
| System idle time | on idle/return transitions | away detection |
| Heartbeat + connection state | periodic | presence, disconnect detection |

### What is NEVER collected
- ❌ Screenshots or screen recording
- ❌ Video or webcam
- ❌ Microphone / audio
- ❌ Keystrokes or keyboard input
- ❌ Document, file, or page contents
- ❌ Clipboard contents
- ❌ Browsing history or URLs (only the window title, and only on a rule match)

The monitoring modules physically do not contain code to read these. On Windows
they call only `GetForegroundWindow`, `GetWindowTextW`, `GetWindowThreadProcessId`,
`QueryFullProcessImageNameW`, `GetLastInputInfo`, `GetTickCount64`. On macOS
they call only System Events (frontmost app + window title) and `ioreg` (idle).

### Title scoping
`MonitoringEventWire.titleScope` is one of `none | app_only | matched | self`:
- `app_only` (default for neutral apps): app name recorded, **title omitted**.
- `matched`: a rule matched → title recorded as warning evidence.
- `self`: focused app is SAFE MUN 2026 → our own title (harmless).
- `none`: no app.

This is enforced client-side and the server stores exactly what it receives.

### Transparency
- The delegate UI always shows the current monitoring status (Active / Standby /
  Idle) and the foreground app being reported.
- The login screen states that monitoring is metadata-only.
- Monitoring pauses during breaks/pauses; the UI shows STANDBY.

## Authentication & authorisation

- **Argon2id** password hashing (OWASP-recommended; memory 19 MiB, time 2, parallelism 1).
- HMAC-SHA256 access + refresh tokens. Only **SHA-256 hashes** of tokens are
  stored — a database leak cannot forge tokens.
- **Role-based authorization** (delegate / chair / admin) enforced server-side
  on every route (`requireRole`, `requireCommitteeChair`). The client role is
  derived from the verified token, never trusted from client state.
- **Single active session per delegate.** Duplicate logins are blocked pending
  chair approval. Crashes do not auto-free a session.
- Refresh tokens are single-use (rotating `jti`); a reused/old refresh token is
  rejected as a replay.
- Login rate limiting (per-username and per-IP token buckets).

## Transport & storage

- **Encrypted local storage:** session tokens and the delegate's Ed25519 private
  key are encrypted with Electron `safeStorage` (DPAPI on Windows, Keychain on
  macOS), bound to the OS user account. They are never written to disk in
  plaintext. If OS encryption is unavailable, secrets are not persisted (the
  user must re-authenticate).
- **Encrypted transport:** deploy behind TLS (reverse proxy / venue certificate)
  for production. The protocol is transport-agnostic; WebSocket and REST both
  run over the same host/port.
- **PostgreSQL:** restrict access to the application DB role. The server's
  Ed25519 receipt-signing private key is stored in `server_config`; protect the
  DB accordingly (see deployment.md).

## Voting integrity

- Votes are **Ed25519-signed** by the delegate's device key; the server verifies
  against the registered public key. The private key never leaves the device.
- Votes are **immutable** (DB trigger forbids UPDATE/DELETE) and **unique per
  delegate** (UNIQUE constraint + `SELECT ... FOR UPDATE` serialises casts).
- Results are **hidden until completion**; reveal is server-gated.
- The server signs an **Ed25519 receipt** for each accepted vote; anyone holding
  the server public key (`GET /server-key`) can verify a recorded vote.

## Audit integrity

- The audit log is **append-only** (DB trigger forbids UPDATE/DELETE) and
  **hash-chained** (`hash_n = SHA-256(prevHash || canonical(fields))`).
- Appends are serialised by a Postgres advisory lock so the chain stays correct
  under concurrency.
- `verifyAuditChain()` recomputes the chain; any tampering breaks it at the
  modified entry. The Admin screen shows live verification status.

## Input validation & rate limiting

- Every REST body and WebSocket payload is validated with Zod at the trust
  boundary (`@mun/protocol` schemas).
- Login brute-force: 5 attempts / 15 s per username; 30 / min per IP.
- Monitoring ingest: per-delegate token bucket (`MUN_MONITOR_MAX_EVENTS_PER_MINUTE`).
- Bounded input sizes (Fastify `bodyLimit`, schema length caps).

## Least privilege

- The renderer has **no Node access** (context isolation on, node integration
  off). It can only call the explicit `window.mun` bridge.
- The renderer never sees raw tokens — chair/admin REST actions go through an
  authenticated `apiRequest` proxy in the main process, which attaches the
  token. The token lives only in the main process / encrypted store.
- Session validation is re-checked on every WebSocket heartbeat; a revoked
  session's socket is closed server-side even if the client misbehaves.

## Known limitations / operational notes

- **macOS Accessibility permission** is required for window-title capture. The
  app prompts on first use; without it, only app names (not titles) are
  captured. Grant it in System Settings → Privacy & Security → Accessibility.
- The server Ed25519 private key is in the DB; a DB compromise would let an
  attacker forge receipts (but not votes, which require delegate keys). For
  high-assurance deployments, move the key to a managed secret.
- Single-process server: suitable for one venue / ~500 delegates. Multi-venue or
  >500 would need an external pub/sub and sticky sessions.
