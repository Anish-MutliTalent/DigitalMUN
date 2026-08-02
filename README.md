# SAFE MUN 2026

**Committee integrity monitoring for physical Model United Nations conferences.**

SAFE MUN 2026 is a production-grade desktop application that preserves committee
integrity at in-person MUN conferences. Delegates debate physically; the
software runs on each delegate's, chair's, and administrator's laptop and
monitors **only the metadata required for integrity** — which application is in
the foreground, whether an AI assistant is being used, idle/away state — and
enforces rules, voting, and session discipline in real time.

> **Privacy by design.** SAFE MUN 2026 never captures screenshots, video, audio,
> webcam, keystrokes, document contents, or clipboard data. Window titles are
> recorded **only** when an integrity rule actually matches. Monitoring is
> transparent, minimal, and event-driven. See [docs/security.md](docs/security.md).

## Priorities (highest → lowest)

1. Desktop monitoring
2. Integrity enforcement
3. Delegate management
4. Chair management
5. Digital voting
6. Administration
7. Reports & analytics

## Stack

| Layer | Technology |
| --- | --- |
| Desktop app | Electron + React + TypeScript + Tailwind (Vite/electron-vite) |
| Native monitoring | Win32 via `koffi` (Windows); System Events via `osascript` (macOS) |
| Server | Node.js + Fastify + WebSocket + PostgreSQL (`pg`) |
| Shared | `@mun/protocol` (types + Zod), `@mun/crypto` (Ed25519, hash-chain, HMAC) |
| Crypto | Ed25519 vote signatures, server-signed receipts, SHA-256 audit chain, Argon2id passwords |

No native compilation is required to build or run (all native code uses prebuilt
binaries: Electron, koffi, @node-rs/argon2). The desktop main process builds as
CommonJS for Electron compatibility; the renderer is a Vite React app.

## Repository layout

```
packages/
  protocol/   shared domain types, WebSocket protocol, Zod schemas, AI rules
  crypto/     Ed25519 keys, vote signing, receipts, audit hash-chain, HMAC tokens
apps/
  server/     Fastify HTTP + WebSocket server, Postgres persistence, all services
  desktop/    Electron app (main / preload / renderer)
docs/         architecture, security, deployment, testing, manuals
scripts/      smoke + koffi verification scripts
```

## Quick start (development)

Prerequisites: Node 20+, pnpm 10+, PostgreSQL 14+.

```bash
pnpm install

# 1. Create the database and run migrations + seed (demo data)
createdb mun_guardian
pnpm migrate
SEED_DEMO=1 pnpm seed          # admin + demo committee/chair/delegates + AI rules

# 2. Start the server
pnpm server:dev                # http://localhost:8080  (ws at /ws)

# 3. Launch the desktop app (in another terminal)
pnpm desktop:dev
```

Demo logins (after `SEED_DEMO=1`):

| Role | Username | Password |
| --- | --- | --- |
| Admin | `admin` | `change-me-immediately` |
| Chair | `chair` | `chair` |
| Delegate | `delegate_<country>` (e.g. `delegate_france`) | `delegate` |

## Tests

```bash
pnpm test            # all packages
```

- `@mun/crypto`: 22 unit tests (Ed25519, canonical JSON, audit hash-chain,
  tokens, vote signing/receipts).
- `@mun/server`: 11 integration tests against an isolated Postgres DB
  (voting end-to-end, single-device auth, monitoring ingest idempotency,
  audit-chain integrity).

See [docs/testing.md](docs/testing.md).

## Build & package

```bash
pnpm build                       # build all packages + apps
pnpm --filter @mun/desktop dist  # Windows installer (NSIS) / macOS dmg
```

See [docs/deployment.md](docs/deployment.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Security & privacy](docs/security.md)
- [Deployment](docs/deployment.md)
- [Testing](docs/testing.md)
- [Developer guide](docs/developer.md)
- [Administrator manual](docs/admin-manual.md)
- [Chair manual](docs/chair-manual.md)
- [Delegate manual](docs/delegate-manual.md)

## License

MIT
