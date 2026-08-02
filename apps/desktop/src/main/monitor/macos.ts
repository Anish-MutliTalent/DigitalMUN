/**
 * @mun/desktop — macOS monitoring via System Events (osascript)
 *
 * Captures the same metadata as the Windows monitor using AppleScript / System
 * Events:
 *  - Frontmost application name
 *  - Front window title (requires Accessibility permission for the app)
 *  - System idle time (ioreg → HIDIdleTime in nanoseconds → ms)
 *
 * Accessibility permission: the first time osascript queries another app's
 * windows, macOS prompts the user to grant MUN Guardian Accessibility access
 * in System Settings → Privacy & Security. The UI surfaces this via status().
 *
 * NOTE: written to the documented System Events APIs; final runtime validation
 * must happen on macOS hardware.
 */

import { execSync } from 'node:child_process';
import type { ForegroundSample, Monitor } from './platform.js';

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export class MacosMonitor implements Monitor {
  private accessibilityDenied = false;

  supportsTitle(): boolean {
    return true;
  }

  status(): string {
    if (this.accessibilityDenied) {
      return 'Accessibility permission required: System Settings → Privacy & Security → Accessibility → enable SAFE MUN 2026.';
    }
    return 'macOS monitoring active';
  }

  sample(): ForegroundSample | null {
    const appName =
      sh(
        `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
      ) || null;

    let title: string | null = null;
    if (appName) {
      const t = sh(
        `osascript -e 'tell application "System Events" to get title of front window of (first application process whose frontmost is true)'`,
      );
      if (t === '' && !this.accessibilityDenied) {
        // Empty title might just mean no window; only flag accessibility if
        // the process query itself is failing — detected below.
      }
      title = t || null;
    }

    // Detect accessibility denial: if app name works but window queries throw,
    // System Events raises an error that execSync swallows → empty. We can't
    // perfectly distinguish "no window" from "denied", so we keep title null.
    if (appName && title === null) {
      // Probe: list windows of the frontmost app. If it errors, accessibility is denied.
      const probe = sh(
        `osascript -e 'tell application "System Events" to count windows of (first application process whose frontmost is true)'`,
      );
      if (probe === '' && appName !== 'Finder') {
        this.accessibilityDenied = true;
      } else if (probe !== '' && Number(probe) > 0) {
        // Has windows but title read failed — retry once.
        const t2 = sh(
          `osascript -e 'tell application "System Events" to get title of front window of (first application process whose frontmost is true)'`,
        );
        title = t2 || null;
      }
    }

    const idleMs = this.idleMs();
    return { appName, title, idleMs };
  }

  private idleMs(): number {
    // HIDIdleTime is in nanoseconds. Convert to ms.
    const out = sh(`ioreg -c IOHIDSystem -d 1 | awk '/HIDIdleTime/ {print int($NF/1000000); exit}'`);
    const n = Number(out);
    return Number.isFinite(n) ? n : 0;
  }

  dispose(): void {}
}
