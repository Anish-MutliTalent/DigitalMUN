# Deployment Guide

SAFE MUN 2026 runs at a single conference venue. You need:

1. A **server machine** (a dedicated laptop or small box on the venue network)
   running the Node server + PostgreSQL. Delegates/chairs/admins connect to it
   over the venue LAN/Wi-Fi.
2. **Desktop clients** installed on each delegate's, chair's, and admin's
   Windows or macOS laptop.

## Server

### Prerequisites
- Node.js 20+ (tested on Node 23; 20+ supported)
- PostgreSQL 14+ (tested on 17/18)
- pnpm 10+

### Database
Create a database and user for the app:

```sql
-- run as a superuser (psql -U postgres)
CREATE USER mun WITH PASSWORD 'choose-a-strong-password';
CREATE DATABASE mun_guardian OWNER mun;
```

The server reads connection info from env vars (see `.env.example`):

```
PGHOST=localhost
PGPORT=5432
PGUSER=mun
PGPASSWORD=choose-a-strong-password
PGDATABASE=mun_guardian
```

### Configuration
Copy `.env.example` to `.env` and set **at least**:

- `MUN_SESSION_SECRET` — 32+ random bytes (hex). Generate with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `MUN_REFRESH_SECRET` — a different 32+ random byte hex string.
- `MUN_BOOTSTRAP_ADMIN_PASSWORD` — a strong initial admin password (change it
  immediately after first login via the Admin screen → create a new admin, then
  remove the bootstrap or change its password).
- `MUN_HOST` / `MUN_PORT` — bind address. Use `0.0.0.0` and the venue-facing
  port (default 8080). For TLS, put the server behind a reverse proxy
  (nginx/Caddy) with a venue certificate and terminate TLS there; point the
  desktop clients at `https://venue-host`.

### Install, migrate, seed, run
On the server machine:

```bash
pnpm install --prod
pnpm --filter @mun/protocol build
pnpm --filter @mun/crypto build
pnpm --filter @mun/server build

pnpm migrate                      # apply schema migrations
pnpm seed                         # bootstrap admin + built-in AI rules
# (optional, dev only) SEED_DEMO=1 pnpm seed   # demo committee + delegates

# Production start:
pnpm --filter @mun/server start   # node dist/index.js
```

Run it under a process manager (pm2, systemd, Windows Service via nssm, or
Docker — see `Dockerfile` / `docker-compose.yml`). The server is a single
process; the pg pool size (`PG_POOL_MAX`, default 20) is the main tunable.

### Docker
A `Dockerfile` and `docker-compose.yml` are provided:

```bash
docker compose up --build   # server + postgres
```

Adjust env vars in `docker-compose.yml`. The server listens on `0.0.0.0:8080`.

### Venue network
- Ensure delegates' laptops can reach the server host on the chosen port
  (firewall rules, same VLAN/Wi-Fi).
- The desktop client's server URL is configurable at the login screen
  (Server settings). Set it to `http://<server-host>:8080` (or the TLS URL).
- For conferences without internet, the server and clients need no external
  connectivity — everything runs on the venue LAN.

## Desktop

### Build installers
On a build machine (Windows for the Windows installer, macOS for the dmg):

```bash
pnpm install
pnpm --filter @mun/protocol build
pnpm --filter @mun/crypto build
pnpm --filter @mun/desktop dist
```

`electron-builder` produces:
- Windows: `apps/desktop/release/MUN-Guardian-Setup-<version>.exe` (NSIS installer)
- macOS: `apps/desktop/release/MUN-Guardian-<version>.dmg`

The installer bundles the renderer and the unpacked `koffi` native binary.

### Distribute
- Distribute the installer to delegates/chairs/admins (USB, venue download
  portal, etc.).
- On first launch, each user sets the server URL (Server settings on the login
  screen) and signs in with credentials the admin provisioned.

### macOS note
Delegates must grant **Accessibility** permission to SAFE MUN 2026 (System
Settings → Privacy & Security → Accessibility) for window-title capture. The
app surfaces this in its status.

## Provisioning a conference

1. Admin signs in → **Users** tab → create a chair and one user per delegate
   (role `delegate`).
2. Admin → **Committees** tab → create each committee and assign its chair.
3. Admin → add each delegate to their committee with a country
   (`/admin/committee/:id/delegate`).
4. Chair signs in → roll call (set attendance), schedule breaks, open votes.
5. Delegates sign in → their voting key is generated on first login and
   registered automatically.

## Backups

PostgreSQL holds all state. Back up with `pg_dump` regularly during the
conference. The audit log and vote records are append-only and tamper-evident;
backups preserve the chain.

## Emergency

- **Admin → Emergency stop** on a committee pauses monitoring and locks the
  committee; **Emergency resume** restores it.
- **Chair → Force logout** immediately revokes a delegate's session and forces
  their client out.
