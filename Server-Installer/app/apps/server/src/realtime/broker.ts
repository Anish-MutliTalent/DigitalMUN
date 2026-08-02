/**
 * @mun/server — realtime broker (in-process pub/sub)
 *
 * The server is a single process, so an in-process broker is correct and
 * avoids the latency of an external pub/sub. Channels are per committee; admins
 * receive every committee's traffic. Broadcasts are non-blocking — a slow
 * client never stalls the broker (its socket buffer is the backpressure).
 */

import type { Envelope } from '@mun/protocol';
import { envelope as makeEnvelope } from '@mun/protocol';
import type { ClientSink } from './types.js';

class Broker {
  private readonly committeeSinks = new Map<string, Set<ClientSink>>();
  private readonly adminSinks = new Set<ClientSink>();
  private readonly sinksById = new Map<string, ClientSink>();

  /** Register a connected sink on its committee channel (+ admin if admin). */
  subscribe(sink: ClientSink): void {
    this.sinksById.set(sink.id, sink);
    if (sink.role === 'admin') {
      this.adminSinks.add(sink);
    }
    if (sink.committeeId) {
      let set = this.committeeSinks.get(sink.committeeId);
      if (!set) {
        set = new Set();
        this.committeeSinks.set(sink.committeeId, set);
      }
      set.add(sink);
    }
  }

  /** Remove a sink from all channels. */
  unsubscribe(sink: ClientSink): void {
    this.sinksById.delete(sink.id);
    this.adminSinks.delete(sink);
    if (sink.committeeId) {
      const set = this.committeeSinks.get(sink.committeeId);
      if (set) {
        set.delete(sink);
        if (set.size === 0) this.committeeSinks.delete(sink.committeeId);
      }
    }
  }

  /** Broadcast to every subscriber of a committee (chairs + admins). */
  broadcastCommittee(committeeId: string, env: Envelope): void {
    const data = JSON.stringify(env);
    const set = this.committeeSinks.get(committeeId);
    if (set) {
      for (const s of set) {
        if (s.role !== 'delegate') this.safeSend(s, data); // chairs see it
      }
    }
    for (const a of this.adminSinks) this.safeSend(a, data);
  }

  /** Broadcast to every subscriber of a committee INCLUDING delegates. */
  broadcastCommitteeAll(committeeId: string, env: Envelope): void {
    const data = JSON.stringify(env);
    const set = this.committeeSinks.get(committeeId);
    if (set) {
      for (const s of set) this.safeSend(s, data);
    }
    for (const a of this.adminSinks) this.safeSend(a, data);
  }

  /** Broadcast to admins only (system-wide events). */
  broadcastAdmins(env: Envelope): void {
    const data = JSON.stringify(env);
    for (const a of this.adminSinks) this.safeSend(a, data);
  }

  /** Broadcast to every committee's members (all roles) + admins (global events). */
  broadcastAllCommitteesAll(env: Envelope): void {
    const data = JSON.stringify(env);
    for (const set of this.committeeSinks.values()) {
      for (const s of set) this.safeSend(s, data);
    }
    for (const a of this.adminSinks) this.safeSend(a, data);
  }

  /** Send to a single delegate/sink (e.g. force_logout, vote_cast_ack). */
  sendToDelegate(delegateId: string, env: Envelope): void {
    for (const s of this.sinksById.values()) {
      if (s.delegateId === delegateId) this.safeSend(s, JSON.stringify(env));
    }
  }

  sendToSink(sinkId: string, env: Envelope): boolean {
    const s = this.sinksById.get(sinkId);
    if (!s) return false;
    this.safeSend(s, JSON.stringify(env));
    return true;
  }

  /** Send to the chair(s) of a committee and admins. */
  sendToCommitteeChairs(committeeId: string, env: Envelope): void {
    const data = JSON.stringify(env);
    const set = this.committeeSinks.get(committeeId);
    if (set) {
      for (const s of set) {
        if (s.role === 'chair') this.safeSend(s, data);
      }
    }
    for (const a of this.adminSinks) this.safeSend(a, data);
  }

  /** Count live sinks (for health). */
  count(): { delegates: number; chairs: number; admins: number; total: number } {
    let delegates = 0;
    let chairs = 0;
    let admins = 0;
    for (const s of this.sinksById.values()) {
      if (s.role === 'delegate') delegates++;
      else if (s.role === 'chair') chairs++;
      else admins++;
    }
    return { delegates, chairs, admins, total: this.sinksById.size };
  }

  /** Live committee member sinks (for presence sync on reconnect). */
  committeeSinkIds(committeeId: string): string[] {
    const set = this.committeeSinks.get(committeeId);
    return set ? [...set].map((s) => s.id) : [];
  }

  private safeSend(sink: ClientSink, data: string): void {
    if (!sink.isAlive()) return;
    try {
      sink.send(data);
    } catch {
      // Socket closed between isAlive() and send() — drop silently.
    }
  }
}

export const broker = new Broker();

/** Helper to build + broadcast a committee envelope in one call. */
export function broadcastCommittee(committeeId: string, t: Envelope['t'], payload: unknown): void {
  broker.broadcastCommittee(committeeId, makeEnvelope(t, payload));
}
