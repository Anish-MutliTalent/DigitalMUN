# Delegate Manual

SAFE MUN 2026 runs on your laptop during the conference to preserve committee
integrity. It is **transparent and metadata-only**.

## What it does and doesn't do
- **It records:** the foreground application name, and the window title **only
  when an integrity rule matches** (e.g. an AI assistant), plus idle/away state.
- **It never records:** screenshots, video, audio, webcam, keystrokes, document
  contents, or clipboard contents. It cannot read these.
- The status panel always shows what is currently being reported.

## Signing in
1. Launch SAFE MUN 2026.
2. Enter the credentials your administrator gave you. Set the **server URL** in
   *Server settings* if it isn't preconfigured.
3. On first login, SAFE MUN 2026 generates a voting key on your device and
   registers the public half with the server. The private key stays on your
   device (encrypted by your OS).

> **One device at a time.** If you are already signed in elsewhere, a second
> login is blocked and the chair is notified. Wait for the chair to approve the
> re-login, then sign in again. A crash does **not** free your session — you
> must request re-login to sign back in from a new device.

## The delegate screen
- **Status:** monitoring state (Active / Standby / Idle), connection, current
  foreground app, and present/away/flagged indicator.
- **Committee:** name, topic, your country, attendance, committee status.
- **Active vote:** the open question with **FOR** and **AGAINST** buttons, the
  `submitted / required` count, and — after you vote — your verifiable receipt.
- **Past votes:** revealed results (FOR/AGAINST counts); unrevealed votes show
  "hidden until all delegates vote".
- **Integrity warnings:** warnings addressed to you (e.g. an AI app was
  detected).
- **Re-login requests:** the status of any re-login you requested.

## Voting
- When the chair opens a vote, it appears immediately.
- Choose **FOR** or **AGAINST** (no abstention). Your choice is signed with your
  device key and sent to the server. You see a **receipt** you can keep.
- You can vote only once per question. Votes are immutable and cryptographically
  verifiable.
- Results are hidden until every enabled, checked-in delegate has voted. The
  chair reveals the totals after that.

## Behaviour expectations
- Keep SAFE MUN 2026 in the foreground during debate. Switching to another app
  is visible to the chair in real time.
- **Do not use AI assistants** (ChatGPT, Claude, Gemini, Copilot, DeepSeek,
  Perplexity, Grok, etc.) — these are detected and flagged to the chair
  immediately, with the window title as evidence.
- During breaks, monitoring pauses (Standby) and resumes automatically.

## If something goes wrong
- **App crash / laptop restart:** relaunch SAFE MUN 2026; if your session is
  still active you'll be guided to request re-login (the chair approves).
- **Network drop:** the app reconnects automatically and buffers any pending
  events; no action needed.
- **Won't vote / error:** tell your chair; do not try to vote twice.
