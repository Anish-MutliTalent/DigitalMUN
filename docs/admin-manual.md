# Administrator Manual

The admin runs the whole conference: provisioning users and committees, system
health, emergency controls, audit, and AI-detection rules.

## Signing in
Launch SAFE MUN 2026 → enter the admin credentials (the bootstrap admin is
`admin` / the password set via `MUN_BOOTSTRAP_ADMIN_PASSWORD`; **change it
immediately** by creating a new admin and rotating the password). Set the server
URL in **Server settings** if needed.

## Tabs

### Health
Live system dashboard: uptime, connected delegates/chairs, committees, open
votes, warnings and events in the last hour, DB latency, WebSocket connections,
and overall health. Refreshes automatically via the realtime `system_health`
push.

### Committees
- **Create committee:** name, topic, (optional) chair user id.
- Per committee: status badge and **Emergency stop** / **Emergency resume**.
  Emergency stop pauses monitoring and locks the committee; use it for serious
  integrity incidents. Resume restores normal operation.
- Assign delegates to a committee via the Users tab or
  `POST /admin/committee/:id/delegate` (add by user id + country).

### Users
- **Create user:** username, password, display name, role (`delegate`, `chair`,
  `admin`).
- List shows role, display name, committee, and a **Force logout** action per
  user (revokes all their sessions).

### Sessions
All active (non-revoked, unexpired) sessions: user, role, platform, created /
last-seen / expiry times. Useful for spotting stale or unexpected sessions.

### Audit Log
- The tamper-evident, append-only hash chain. Each entry: seq, time, actor,
  action, subject, detail.
- A banner shows **Hash chain intact (N entries)** or **Chain BROKEN at seq X**.
  A broken chain indicates tampering with the audit log.
- **Export** downloads the log + verification as JSON for external archiving.

### AI Rules
- Lists every detection rule (name, pattern, platform, severity, enabled).
- **Add rule:** name, pattern (substring matched against app name or window
  title), platform. New rules sync to every delegate instantly — no app update.
- Toggle **enabled** on/off per rule.
- Add new AI services here as they appear (e.g. a new chatbot).

## Provisioning a conference (checklist)
1. Create a chair user per committee (Users tab).
2. Create a delegate user per delegate (Users tab).
3. Create each committee and assign its chair (Committees tab).
4. Add each delegate to their committee with their country.
5. Have the chair sign in, do roll call, and schedule breaks.
6. Have delegates sign in (their voting key is generated and registered on first
   login).
7. Monitor the Health and Audit tabs during the session.

## Emergency playbook
- **Suspected mass integrity breach:** Emergency stop the affected committee →
  investigate via Audit Log and committee exports → Emergency resume when safe.
- **Compromised delegate device:** find the user (Users) → Force logout. Their
  next login needs chair re-login approval.
- **Server problem:** check Health (DB latency, connection counts); restart the
  server process (clients auto-reconnect; sessions persist).
