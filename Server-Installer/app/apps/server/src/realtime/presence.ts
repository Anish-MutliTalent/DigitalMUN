/**
 * @mun/server — presence tracker
 *
 * Maintains an in-memory live status for every connected delegate and drives
 * the chair dashboard's "live delegate status" feed. Heartbeats refresh
 * `lastHeartbeatAt`; a periodic sweep marks delegates whose heartbeat is stale
 * as `disconnected` (the session is NOT revoked — see sessions.ts — so the
 * delegate must request re-login to return). Disconnects raise a warning and
 * are persisted to the delegates table.
 */

import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { broker } from './broker.js';
import { envelope, type ConnectionStatus, type Attendance } from '@mun/protocol';
import { audit } from '../audit/service.js';
import { randomUuid } from '@mun/crypto';

interface PresenceRecord {
  delegateId: string;
  committeeId: string;
  userId: string;
  displayName: string;
  country: string;
  connectionStatus: ConnectionStatus;
  attendance: Attendance;
  enabled: boolean;
  lastHeartbeatAt: number | null;
  currentAppName: string | null;
  away: boolean;
  flagged: boolean;
  updatedAt: number;
}

class PresenceStore {
  private readonly records = new Map<string, PresenceRecord>();
  private sweepTimer: NodeJS.Timeout | null = null;

  /** Register/refresh a delegate's presence on connect. */
  register(rec: Omit<PresenceRecord, 'updatedAt' | 'currentAppName' | 'away' | 'flagged'>): void {
    const existing = this.records.get(rec.delegateId);
    const record: PresenceRecord = {
      ...rec,
      currentAppName: existing?.currentAppName ?? null,
      away: existing?.away ?? false,
      flagged: existing?.flagged ?? false,
      updatedAt: Date.now(),
    };
    this.records.set(rec.delegateId, record);
    this.broadcast(record);
  }

  /** Update mutable presence fields (from monitoring events / heartbeats). */
  update(
    delegateId: string,
    patch: Partial<Pick<PresenceRecord, 'currentAppName' | 'away' | 'flagged' | 'attendance' | 'enabled' | 'connectionStatus' | 'lastHeartbeatAt'>>,
  ): void {
    const rec = this.records.get(delegateId);
    if (!rec) return;
    Object.assign(rec, patch, { updatedAt: Date.now() });
    this.broadcast(rec);
  }

  heartbeat(delegateId: string, monitoringActive: boolean): void {
    const rec = this.records.get(delegateId);
    if (!rec) return;
    rec.lastHeartbeatAt = Date.now();
    if (rec.connectionStatus !== 'connected') {
      rec.connectionStatus = 'connected';
    }
    // If monitoring isn't active, the delegate is effectively away (break/pause).
    if (!monitoringActive && rec.connectionStatus === 'connected') {
      // During breaks the chair sees STANDBY; we don't mark "away" here.
    }
    rec.updatedAt = Date.now();
    // Persist heartbeat (throttled-ish; cheap upsert of last_heartbeat_at).
    void pool
      .query(
        'UPDATE delegates SET last_heartbeat_at = $1, connection_status = $2 WHERE id = $3',
        [rec.lastHeartbeatAt, rec.connectionStatus, rec.delegateId],
      )
      .catch(() => {});
    this.broadcast(rec);
  }

  /** Mark a delegate disconnected (timeout / explicit). */
  async markDisconnected(delegateId: string, reason: string): Promise<void> {
    const rec = this.records.get(delegateId);
    if (!rec) return;
    if (rec.connectionStatus === 'disconnected') return; // already
    rec.connectionStatus = 'disconnected';
    rec.updatedAt = Date.now();
    await pool.query(
      'UPDATE delegates SET connection_status = $1 WHERE id = $2',
      ['disconnected', rec.delegateId],
    );
    this.broadcast(rec);
    // Raise a disconnected warning — use ONE id for both the DB row and the
    // broadcast so the chair can acknowledge it by the id it received.
    const warningId = randomUuid();
    const timestamp = Date.now();
    const message = `Delegate disconnected: ${reason}`;
    await pool.query(
      `INSERT INTO warnings (id, committee_id, delegate_id, type, severity, message, timestamp)
       VALUES ($1, $2, $3, 'disconnected', 'warning', $4, $5)`,
      [warningId, rec.committeeId, rec.delegateId, message, timestamp],
    );
    broker.broadcastCommittee(
      rec.committeeId,
      envelope('warning', {
        warning: {
          id: warningId,
          committeeId: rec.committeeId,
          delegateId: rec.delegateId,
          type: 'disconnected',
          severity: 'warning',
          message,
          ruleId: null,
          appName: null,
          timestamp,
          acknowledged: false,
          acknowledgedBy: null,
          acknowledgedAt: null,
        },
      }),
    );
    await audit({
      actor: 'system',
      action: 'monitor_event',
      subject: rec.delegateId,
      detail: `Delegate ${rec.displayName} disconnected (${reason}).`,
    });
  }

  remove(delegateId: string): void {
    this.records.delete(delegateId);
  }

  get(delegateId: string): PresenceRecord | undefined {
    return this.records.get(delegateId);
  }

  listByCommittee(committeeId: string): PresenceRecord[] {
    return [...this.records.values()].filter((r) => r.committeeId === committeeId);
  }

  /** Start the periodic timeout sweep. */
  startSweep(intervalMs = 2000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const timeout = config.heartbeatTimeoutMs;
    for (const rec of this.records.values()) {
      if (rec.connectionStatus !== 'connected') continue;
      if (rec.lastHeartbeatAt && now - rec.lastHeartbeatAt > timeout) {
        await this.markDisconnected(rec.delegateId, 'heartbeat timeout');
      }
    }
  }

  private broadcast(rec: PresenceRecord): void {
    broker.broadcastCommittee(
      rec.committeeId,
      envelope('delegate_status', {
        delegateId: rec.delegateId,
        committeeId: rec.committeeId,
        connectionStatus: rec.connectionStatus,
        attendance: rec.attendance,
        enabled: rec.enabled,
        lastHeartbeatAt: rec.lastHeartbeatAt,
        currentAppName: rec.currentAppName,
        away: rec.away,
        flagged: rec.flagged,
        updatedAt: rec.updatedAt,
      }),
    );
  }
}

export const presence = new PresenceStore();
