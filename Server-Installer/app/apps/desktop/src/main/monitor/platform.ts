/**
 * @mun/desktop — monitoring platform abstraction
 *
 * A `Monitor` produces a `ForegroundSample` on each poll: the foreground app
 * name, its window title (when available), and the system idle duration. The
 * engine polls at a fixed cadence and emits events on change. Platform modules:
 *  - windows.ts: Win32 via koffi (GetForegroundWindow, GetWindowTextW, …).
 *  - macos.ts:  System Events via osascript (needs Accessibility permission).
 *
 * Privacy: only the app name and (when a rule matches) the title leave the
 * device. No screenshots, document contents, keystrokes, or clipboard data are
 * ever read. See docs/architecture.md → Privacy.
 */

import { WindowsMonitor } from './windows.js';
import { MacosMonitor } from './macos.js';

export interface ForegroundSample {
  /** Process / application name (e.g. "chrome", "Code.exe"). */
  appName: string | null;
  /** Window title (e.g. "ChatGPT - Google Chrome"). */
  title: string | null;
  /** System-wide idle duration in ms (time since last input). */
  idleMs: number;
}

export interface Monitor {
  /** Read the current foreground sample. Returns null if unavailable. */
  sample(): ForegroundSample | null;
  /** Whether the platform supports title capture (for UI guidance). */
  supportsTitle(): boolean;
  /** Human-readable permission/status hint for the UI. */
  status(): string;
  /** Dispose any resources. */
  dispose(): void;
}

let cached: Monitor | null = null;

export function getMonitor(): Monitor {
  if (cached) return cached;
  const platform = process.platform;
  if (platform === 'win32') {
    cached = new WindowsMonitor();
  } else if (platform === 'darwin') {
    cached = new MacosMonitor();
  } else {
    cached = new UnsupportedMonitor();
  }
  return cached;
}

class UnsupportedMonitor implements Monitor {
  sample(): ForegroundSample | null {
    return null;
  }
  supportsTitle(): boolean {
    return false;
  }
  status(): string {
    return `Monitoring not supported on ${process.platform}`;
  }
  dispose(): void {}
}
