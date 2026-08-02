# Chair Manual

The chair runs a single committee: roll call, monitoring oversight, warnings,
re-login approvals, voting, breaks, and log export.

## Signing in
Launch SAFE MUN 2026 → enter your chair credentials. You see only your committee.

## Top bar
- Committee name, topic, and status badge (active / paused / break / emergency).
- **Pause / Resume:** pauses monitoring (delegates see STANDBY). Use for
  procedural pauses. (Emergency stop/resume is admin-only.)
- **Export logs:** downloads the committee's monitoring events + warnings as JSON.

## Delegate roster
- One row per delegate: country, attendance (dropdown: `not_checked_in`,
  `present`, `voting`, `absent`), live connection status, current foreground app,
  away/flagged/disabled badges.
- **Attendance:** set during roll call. Only `present`/`voting` delegates are
  eligible to vote.
- **Enable / Disable** (shield icon): disabled delegates cannot vote and are
  removed from the required vote count — use this for absent delegates so a vote
  can complete.
- **Force logout** (icon): immediately revokes the delegate's session and forces
  their client out. Their next login requires your re-login approval.

## Live monitoring feed
Real-time stream of delegate focus changes and AI detections: time, country,
app, matched rule (red badge for AI), away/return durations. This is the same
metadata delegates' clients report — no screens or content.

## Warnings
Integrity warnings (AI detected, unexpected app, away, disconnected) with
severity and time. **Acknowledge** each warning once handled. Unacknowledged
warnings are counted in the top stats.

## Re-login requests
When a delegate tries to sign in on a second device (or after a crash that left
  their session active), a re-login request appears here. **Approve** (revokes
  their old session, lets them sign in) or **Deny**. Approve only after
  confirming the request is legitimate.

## Voting
- **Open vote:** type the question → **Open vote**. Delegates see it immediately.
- Each vote shows `submitted / required` (e.g. `18 / 24`). **Choices are hidden
  until reveal.**
- **Close** ends voting (results stay hidden).
- **Reveal** is enabled only when `submitted >= required` (all enabled, present
  delegates have voted). If a delegate is absent and blocking completion,
  **disable** them in the roster to lower the required count, then Reveal.
- After reveal, FOR/AGAINST counts are shown to everyone.

## Breaks
- **Schedule a break:** label, start, end (date-time). During the break,
  monitoring pauses and delegate UIs show STANDBY; it resumes automatically when
  the break ends.
- **Cancel break** while active.

## Tips
- Keep the roster visible during debate to spot disconnected or flagged
  delegates quickly.
- Acknowledge warnings promptly so the unacked count is a reliable signal.
- For a stuck vote (a delegate won't vote and won't respond), disable them
  rather than waiting indefinitely.
