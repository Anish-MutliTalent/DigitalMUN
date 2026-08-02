/**
 * @mun/desktop renderer — shared UI primitives
 *
 * Small, accessible, theme-aware components used across all four role screens.
 * Built on Tailwind tokens (see styles.css). No external UI dependency.
 */

import { useEffect, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useStore } from '../store';

export function Card({
  children,
  className = '',
  variant = 'light',
}: {
  children: ReactNode;
  className?: string;
  variant?: 'light' | 'dark';
}) {
  const cls = variant === 'dark' ? 'card-dark' : 'card';
  return <div className={`${cls} ${className}`}>{children}</div>;
}

export function SectionTitle({
  children,
  action,
  underline = true,
  underlineClass,
  className = '',
}: {
  children: ReactNode;
  action?: ReactNode;
  underline?: boolean;
  underlineClass?: string;
  className?: string;
}) {
  return (
    <div className={`mb-4 ${className}`}>
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-xs font-semibold uppercase tracking-widest text-text/80">
          {children}
        </h2>
        {action}
      </div>
      {underline && (
        <div
          className={`mt-2 h-[1.5px] w-10 ${underlineClass ?? 'bg-text/30'}`}
        />
      )}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'primary';
}) {
  const cls = {
    neutral: 'bg-stone-200/70 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
    success: 'bg-emerald-100/80 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300',
    warning: 'bg-amber-100/80 text-amber-800 dark:bg-amber-950/80 dark:text-amber-300',
    danger: 'bg-rose-100/80 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300',
    primary: 'bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-100',
  }[tone];
  return <span className={`badge ${cls}`}>{children}</span>;
}

export function StatusDot({ tone, label }: { tone: 'success' | 'warning' | 'danger' | 'muted'; label?: string }) {
  const color = {
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    muted: 'bg-muted',
  }[tone];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden />
      {label && <span className="text-xs text-text">{label}</span>}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  className = '',
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const cls = variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : 'btn-ghost';
  return (
    <button type={type} className={`${cls} ${className}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`input ${props.className ?? ''}`} />;
}

export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'success' | 'danger' | 'primary' | 'warning';
}) {
  const color =
    tone === 'success'
      ? 'text-success'
      : tone === 'danger'
        ? 'text-danger'
        : tone === 'primary'
          ? 'text-primary'
          : tone === 'warning'
            ? 'text-warning'
            : 'text-text';
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-sm text-muted">{children}</div>;
}

export function Toast() {
  const toast = useStore((s) => s.toast);
  const clear = useStore((s) => s.clearToast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clear, 4000);
    return () => clearTimeout(t);
  }, [toast, clear]);
  if (!toast) return null;
  const icon = {
    info: <Info size={16} />,
    success: <CheckCircle2 size={16} />,
    warning: <AlertTriangle size={16} />,
    error: <XCircle size={16} />,
  }[toast.kind];
  const tone = {
    info: 'border-border',
    success: 'border-success/50 text-success',
    warning: 'border-warning/50 text-warning',
    error: 'border-danger/50 text-danger',
  }[toast.kind];
  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div className={`card flex items-center gap-2 ${tone}`}>
        {icon}
        <span className="text-sm text-text">{toast.message}</span>
        <button onClick={clear} className="ml-2 text-muted hover:text-text" aria-label="Dismiss">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

// ─── Formatters ───────────────────────────────────────────────────────────────

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function severityTone(sev: 'info' | 'warning' | 'critical'): 'neutral' | 'warning' | 'danger' {
  return sev === 'critical' ? 'danger' : sev === 'warning' ? 'warning' : 'neutral';
}
