/**
 * @mun/desktop — monitoring engine
 *
 * Polls the platform monitor at a fixed cadence and emits events ONLY on state
 * change (event-driven, never a continuous stream). Emits:
 *  - session_start / session_end : when monitoring starts/stops
 *  - focus_change                : foreground app switched (non-flagged, non-self)
 *  - ai_detected                 : an AI rule matched the app/title
 *  - away / return               : delegate went idle or left MUN Guardian, and came back
 *  - idle                        : system idle beyond the threshold
 *
 * Privacy scoping (titleScope):
 *  - self   : focused app is MUN Guardian (our own title is harmless)
 *  - matched: a rule matched → title included as evidence for the warning
 *  - app_only: neutral app → app name only, title omitted
 *  - none   : no app
 *
 * The engine never reads screenshots, document contents, keystrokes, clipboard,
 * audio, or video. It only reads the foreground app name, its window title, and
 * the system idle timer — all integrity-relevant metadata.
 */

import { randomUUID } from 'node:crypto';
import type {
  MonitoringEventWire,
  MonitoringEventType,
  Severity,
  TitleScope,
  AiDetectionRule,
} from '@mun/protocol';
import { getMonitor, type Monitor, type ForegroundSample } from './platform.js';
import { ruleCache } from './rules.js';
import { SELF_APP_NAMES, MONITOR_POLL_MS, IDLE_THRESHOLD_MS, AWAY_THRESHOLD_MS } from '../config.js';

export interface EngineContext {
  delegateId: () => string | null;
  committeeId: () => string | null;
  platform: 'windows' | 'macos';
  emit: (event: MonitoringEventWire) => void;
  onState: (s: { currentAppName: string | null; away: boolean; flagged: boolean; lastEventAt: number | null }) => void;
}

export class MonitoringEngine {
  private monitor: Monitor;
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private paused = false;

  private lastAppName: string | null = null;
  private lastMatched = false;
  private lastMatchedRuleId: string | null = null;
  private away = false;
  private awaySince = 0;
  private idleActive = false;
  private flagged = false;
  private currentAppName: string | null = null;
  private lastEventAt: number | null = null;

  constructor(private ctx: EngineContext) {
    this.monitor = getMonitor();
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.paused = false;
    this.lastAppName = null;
    this.lastMatched = false;
    this.lastMatchedRuleId = null;
    this.away = false;
    this.idleActive = false;
    this.emit('session_start', null, null, 'none', null, null, 'info', null);
    this.poll(); // immediate first sample so detection isn't delayed by a full interval
    this.timer = setInterval(() => this.poll(), MONITOR_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit('session_end', null, null, 'none', null, null, 'info', null);
    this.pushState();
  }

  pause(reason: string): void {
    this.paused = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void reason;
    this.pushState();
  }

  resume(): void {
    if (!this.active || !this.paused) return;
    this.paused = false;
    this.lastAppName = null; // re-baseline on resume
    this.lastMatched = false;
    this.lastMatchedRuleId = null;
    this.poll(); // immediate first sample on resume
    this.timer = setInterval(() => this.poll(), MONITOR_POLL_MS);
    this.timer.unref?.();
  }

  isPaused(): boolean {
    return this.paused;
  }

  isActive(): boolean {
    return this.active;
  }

  status(): string {
    return this.monitor.status();
  }

  dispose(): void {
    this.stop();
    this.monitor.dispose();
  }

  // ─── internal ──────────────────────────────────────────────────────────────

  private poll(): void {
    if (this.paused) return;
    const delegateId = this.ctx.delegateId();
    const committeeId = this.ctx.committeeId();
    if (!delegateId || !committeeId) return;

    const sample = this.monitor.sample();
    if (!sample) return;

    // Idle handling takes precedence.
    if (sample.idleMs > IDLE_THRESHOLD_MS) {
      if (!this.idleActive) {
        this.idleActive = true;
        this.away = true;
        this.awaySince = Date.now();
        this.emit('idle', sample.appName, null, 'app_only', null, null, 'info', null);
      }
      this.currentAppName = sample.appName;
      this.pushState();
      return;
    } else if (this.idleActive) {
      this.idleActive = false;
      this.emit('return', sample.appName, null, 'app_only', null, null, 'info', Date.now() - this.awaySince);
      this.away = false;
    }

    const appName = (sample.appName ?? '').toLowerCase();
    const isSelf = SELF_APP_NAMES.has(appName) || appName.includes('safe mun') || appName.includes('mun guardian');
    const matched = ruleCache.match(this.ctx.platform, sample.appName, sample.title);
    const matchedRule = matched?.rule ?? null;
    const nowMatched = !!matchedRule;
    const ruleChanged = (matchedRule?.id ?? null) !== this.lastMatchedRuleId;
    const appChanged = appName !== this.lastAppName;

    // Event-driven detection: fire the moment a rule match BECOMES true, OR when
    // switching to a different matched rule/app (e.g. Gemini tab → ChatGPT tab
    // in the same browser). This catches same-process tab switches, not just
    // whole-app switches. Staying on the same matched app/tab does not re-emit.
    if (nowMatched && (!this.lastMatched || ruleChanged || appChanged)) {
      const sev = matchedRule!.severity as Severity;
      this.emit(
        'ai_detected',
        sample.appName,
        sample.title,
        'matched',
        matchedRule!.id,
        matchedRule!.name,
        sev,
        null,
      );
      this.flagged = true;
      if (!this.away) {
        this.away = true;
        this.awaySince = Date.now();
      }
    } else if (!nowMatched && this.lastMatched) {
      // Transition OUT of a flagged app → back to neutral.
      this.flagged = false;
      if (isSelf) {
        if (this.away) {
          this.emit('return', sample.appName, sample.title, 'self', null, null, 'info', Date.now() - this.awaySince);
          this.away = false;
        } else {
          this.emit('focus_change', sample.appName, sample.title, 'self', null, null, 'info', null);
        }
      } else {
        this.emit('focus_change', sample.appName, null, 'app_only', null, null, 'info', null);
        if (!this.away) {
          this.away = true;
          this.awaySince = Date.now();
        }
      }
    } else if (appChanged) {
      // App switch with no match-state change.
      if (isSelf) {
        if (this.away) {
          this.emit('return', sample.appName, sample.title, 'self', null, null, 'info', Date.now() - this.awaySince);
          this.away = false;
        } else {
          this.emit('focus_change', sample.appName, sample.title, 'self', null, null, 'info', null);
        }
        this.flagged = false;
      } else {
        this.emit('focus_change', sample.appName, null, 'app_only', null, null, 'info', null);
        this.flagged = false;
        if (!this.away) {
          this.away = true;
          this.awaySince = Date.now();
        }
      }
    }

    this.lastAppName = appName;
    this.lastMatched = nowMatched;
    this.lastMatchedRuleId = matchedRule?.id ?? null;
    this.currentAppName = sample.appName;
    this.pushState();
  }

  private emit(
    type: MonitoringEventType,
    appName: string | null,
    title: string | null,
    titleScope: TitleScope,
    ruleId: string | null,
    ruleName: string | null,
    severity: Severity,
    durationMs: number | null,
  ): void {
    // Diagnostic: log every emitted event so detection can be verified in the
    // dev log. (Remove for production.)
    // eslint-disable-next-line no-console
    console.log(`[monitor] ${type} app=${appName ?? '—'} title=${title ?? '—'} rule=${ruleName ?? '—'}`);
    const delegateId = this.ctx.delegateId();
    const committeeId = this.ctx.committeeId();
    if (!delegateId || !committeeId) return;
    const ev: MonitoringEventWire = {
      clientEventId: randomUUID(),
      delegateId,
      committeeId,
      type,
      clientTs: Date.now(),
      appName,
      title: titleScope === 'app_only' || titleScope === 'none' ? null : title,
      titleScope,
      matchedRuleId: ruleId,
      matchedRuleName: ruleName,
      severity,
      durationMs,
      fromAppName: null,
    };
    this.lastEventAt = ev.clientTs;
    this.ctx.emit(ev);
    this.pushState();
  }

  private pushState(): void {
    this.ctx.onState({
      currentAppName: this.currentAppName,
      away: this.away || this.idleActive,
      flagged: this.flagged,
      lastEventAt: this.lastEventAt,
    });
  }

  /** Replace the rule set (called on rules_updated). */
  updateRules(rules: AiDetectionRule[]): void {
    ruleCache.set(rules);
  }
}
