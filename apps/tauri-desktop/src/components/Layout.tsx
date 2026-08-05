/**
 * @mun/desktop renderer — app shell
 *
 * Header shows the role, committee, live connection + monitoring status, theme
 * toggle, and logout. The body is the active screen.
 */

import { type ReactNode } from 'react';
import { LogOut, Moon, Sun, Wifi, WifiOff } from 'lucide-react';
import { useStore } from '../store';
import { useTheme } from '../theme';
import { StatusDot } from './ui';
import logo from '../assets/logo.png';

export function Layout({ children }: { children: ReactNode }) {
  const user = useStore((s) => s.user);
  const delegate = useStore((s) => s.delegate);
  const connection = useStore((s) => s.connection);
  const monitoring = useStore((s) => s.monitoring);
  const currentCommittee = useStore((s) => s.currentCommittee);
  const logout = useStore((s) => s.logout);
  const { theme, toggle } = useTheme();

  const wsOk = connection?.ws === 'open';
  const monStatus = connection?.monitoring ?? 'inactive';

  // Monitoring indicator: green dot + current foreground app (delegate only).
  let monitorIndicator: ReactNode = null;
  if (monStatus === 'paused') {
    monitorIndicator = <StatusDot tone="warning" label="Standby" />;
  } else if (monitoring) {
    if (monitoring.away) {
      monitorIndicator = <StatusDot tone="muted" label="Away" />;
    } else if (monitoring.flagged) {
      monitorIndicator = (
        <StatusDot tone="danger" label={`${monitoring.currentAppName ?? 'Flagged app'} · flagged`} />
      );
    } else {
      monitorIndicator = <StatusDot tone="success" label={monitoring.currentAppName ?? 'Active'} />;
    }
  } else {
    monitorIndicator = <StatusDot tone="muted" label="Away" />;
  }

  // Subtitle format: e.g. "Canada • delegate • General Assembly"
  const subtitle = [
    user?.role === 'delegate' ? (delegate?.country ?? user.displayName) : user?.displayName,
    user?.role === 'vice' ? 'moderator' : user?.role,
    currentCommittee?.name,
  ]
    .filter(Boolean)
    .join(' • ');

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <header className="relative z-10 flex items-center justify-between px-8 pt-5 pb-2">
        <div className="flex items-center gap-4">
          <img src={logo} alt="SAFE MUN 2026" className="h-12 w-12 object-contain opacity-90" />
          <div className="flex flex-col justify-center">
            <h1 className="font-serif text-3xl font-normal tracking-wide text-text leading-none">
              SAFE MUN 2026
            </h1>
            <div className="text-sm text-muted/80 tracking-wide mt-1">
              {subtitle}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-4 text-sm font-medium">
            <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              {wsOk ? (
                <>
                  <Wifi size={18} className="stroke-[2.2]" />
                  <span className="text-text font-normal">Connected</span>
                </>
              ) : (
                <>
                  <WifiOff size={18} className="text-danger stroke-[2.2]" />
                  <span className="text-danger font-normal">Offline</span>
                </>
              )}
            </span>
            <span className="text-border">|</span>
            {monitorIndicator}
          </div>

          <button
            onClick={toggle}
            className="rounded-full p-2 text-text/70 hover:bg-surface-2 transition-colors"
            title="Toggle theme"
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>

          {user && user.role !== 'delegate' && (
            <button
              onClick={() => void logout()}
              className="inline-flex items-center gap-1.5 rounded-full p-2 text-muted hover:bg-surface-2 hover:text-text transition-colors"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={18} />
            </button>
          )}
        </div>
        
        {/* Blur fade element at the bottom of the header */}
        <div className="absolute top-full left-0 right-0 h-4 bg-gradient-to-b from-bg to-transparent pointer-events-none" />
      </header>
      <main className="flex-1 overflow-auto px-8 pb-8 pt-4">{children}</main>
    </div>
  );
}
