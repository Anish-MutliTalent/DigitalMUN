// Ad-hoc WebSocket smoke test for the MUN Guardian server.
// Run: node scripts/smoke-ws.mjs
import { randomUUID } from 'node:crypto';

const BASE = 'http://localhost:8080';
const WS = 'ws://localhost:8080/ws';

async function login(username, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, platform: 'windows' }),
  });
  return res.json();
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runDelegate(token, rules) {
  const chatgptRule = rules.find((r) => r.name === 'ChatGPT');
  return new Promise((resolve) => {
    const ws = new WebSocket(WS);
    const log = [];
    let delegateId = null;
    let committeeId = null;
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          v: 1,
          t: 'hello',
          ts: Date.now(),
          id: 'h1',
          payload: { accessToken: token, platform: 'windows', clientVersion: 'smoke-1.0' },
        }),
      );
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      log.push(msg.t);
      if (msg.t === 'welcome') {
        delegateId = msg.payload.delegate?.id;
        committeeId = msg.payload.delegate?.committeeId;
        // Send a ChatGPT focus-change event → should create a warning.
        ws.send(
          JSON.stringify({
            v: 1,
            t: 'monitor_event',
            ts: Date.now(),
            id: 'e1',
            payload: {
              clientEventId: randomUUID(),
              delegateId,
              committeeId,
              type: 'ai_detected',
              clientTs: Date.now(),
              appName: 'Google Chrome',
              title: 'ChatGPT',
              titleScope: 'matched',
              matchedRuleId: chatgptRule?.id ?? null,
              matchedRuleName: 'ChatGPT',
              severity: 'critical',
              durationMs: null,
              fromAppName: 'MUN Guardian',
            },
          }),
        );
      }
      if (msg.t === 'client_ack' || msg.t === 'error') {
        ws.close();
      }
    });
    ws.addEventListener('close', () => resolve({ log, delegateId }));
    ws.addEventListener('error', (e) => resolve({ log, error: String(e) }));
    setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve({ log, timeout: true });
    }, 4000);
  });
}

async function main() {
  const dl = await login('delegate_germany', 'delegate');
  console.log('delegate login:', typeof dl.user?.createdAt === 'number' ? 'createdAt=number OK' : 'createdAt BAD', '| rules:', dl.rules?.length);
  const ch = await login('chair', 'chair');
  const chairToken = ch.accessToken;

  // Run a chair WS (to observe broadcasts) + delegate WS concurrently.
  const chairWs = new WebSocket(WS);
  const chairSeen = [];
  await new Promise((res) => {
    chairWs.addEventListener('open', () => {
      chairWs.send(
        JSON.stringify({ v: 1, t: 'hello', ts: Date.now(), id: 'hc', payload: { accessToken: chairToken, platform: 'windows', clientVersion: 'smoke' } }),
      );
    });
    chairWs.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      chairSeen.push(m.t);
    });
    setTimeout(res, 1500);
  });

  const result = await runDelegate(dl.accessToken, dl.rules);
  console.log('delegate WS msg flow:', result.log.join(' -> '));
  await wait(800);
  console.log('chair saw:', chairSeen.join(', '));
  try {
    chairWs.close();
  } catch {}
}
main().catch((e) => {
  console.error('smoke error', e);
  process.exit(1);
});
