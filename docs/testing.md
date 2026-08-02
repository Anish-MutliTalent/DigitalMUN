# Testing Guide

## Run all tests

```bash
pnpm test
```

## What is covered

### `@mun/crypto` (unit, 22 tests)
- Ed25519 generate / sign / verify; tampered signatures rejected; public-key
  derivation from private key.
- Canonical JSON key ordering, undefined omission, stable hashes.
- Audit hash-chain: clean chain verifies; tampered field, broken prevHash, and
  reordered/missing entries are detected; gaps from rolled-back identity values
  are allowed.
- Session tokens: issue/verify access + refresh; expiry rejection; type
  mismatch; tampered signatures; stable non-reversible token hashes.
- Voting: vote sign/verify; wrong choice / wrong key rejected; server receipt
  sign/verify; tampered receipt rejected.
- Constant-time comparison.

### `@mun/server` (integration, 11 tests)
Run against an **isolated** Postgres database (`mun_guardian_test`, set via
`tests/setup.ts`) using Fastify `inject` (no network). Covers:
- **Auth single-device:** a delegate logs in once; a second login while the
  session is active returns `AUTH_RELOGIN_REQUIRED`.
- **Voting end-to-end:** chair opens a vote; delegate registers a voting key;
  delegate casts a valid signed vote (FOR) and receives a receipt; a duplicate
  cast by the same delegate is idempotently rejected; an invalid signature (wrong
  key) is rejected; reveal succeeds when all enabled delegates have voted;
  pre-reveal public state hides choices.
- **Monitoring ingest:** an `ai_detected` event creates a warning; a duplicate
  (same `clientEventId`) is deduped.
- **Audit chain:** appended entries verify cleanly.

## Setting up the test database

```bash
createdb mun_guardian_test
PGDATABASE=mun_guardian_test pnpm --filter @mun/server migrate
PGDATABASE=mun_guardian_test pnpm --filter @mun/server seed   # admin + rules (no demo)
```

The test setup file (`apps/server/tests/setup.ts`) points the pool at
`mun_guardian_test` (override with `PGDATABASE_TEST`). Tests create and clean up
their own isolated data; the audit log is append-only and is not truncated.

## Type checking

```bash
pnpm typecheck      # all packages
```

## Manual / smoke verification

- `scripts/smoke-ws.mjs` — logs in as a delegate + chair over WebSocket, sends a
  ChatGPT `ai_detected` event, and confirms the chair receives the
  `monitor_broadcast` + `warning` in real time. Run with the server up:
  `node scripts/smoke-ws.mjs`.
- `scripts/verify-koffi.mjs` — exercises the Win32 foreground/idle FFI outside
  Electron (Windows only): `node scripts/verify-koffi.mjs` (use
  `NODE_PATH=apps/desktop/node_modules` if koffi isn't resolvable from the
  repo root).

## Desktop

- `pnpm --filter @mun/desktop typecheck` — type-checks main + renderer.
- `pnpm --filter @mun/desktop build` — full electron-vite build (main + preload
  + renderer).
- `pnpm --filter @mun/desktop dev` — launch the app against a running server.

> Note for sandboxed/headless environments: Electron runs as Node if
> `ELECTRON_RUN_AS_NODE=1` is set. To launch the GUI, unset it:
> `env -u ELECTRON_RUN_AS_NODE pnpm --filter @mun/desktop dev`.
