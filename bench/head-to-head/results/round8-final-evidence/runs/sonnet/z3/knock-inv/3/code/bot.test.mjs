import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'bot-'));
const { deliver, recordDismissal } = await import('./bot.mjs');

const mk = () => {
  const calls = { push: 0, inApp: 0 };
  return { calls, transport: { push: async () => (calls.push++, true), inApp: async () => { calls.inApp++; } } };
};
const consent = { get: async () => ({ push: true }) };
const U = (o = {}) => ({ id: 'u' + Math.random(), timezone: 'Europe/Istanbul', categories: { briefing: true }, snoozedUntil: null, platform: 'ios', notificationsPermitted: true, ...o });
const AM = '2026-10-23T05:00:00Z'; // 08:00 Istanbul

test('sends in the morning', async () => {
  const { transport, calls } = mk();
  const r = await deliver({ user: U(), candidate: { id: 'c1', type: 'briefing' }, now: AM, transport, consentStore: consent });
  assert.deepEqual(r, { push: true, inApp: true, reason: null, resumeAt: null });
  assert.equal(calls.push, 1);
});
test('night waits until 07:00 local', async () => {
  const { transport, calls } = mk();
  const r = await deliver({ user: U(), candidate: { id: 'c2', type: 'briefing' }, now: '2026-10-23T00:00:00Z', transport, consentStore: consent });
  assert.equal(r.push, false); assert.equal(r.resumeAt, '2026-10-23T04:00:00.000Z'); assert.equal(calls.push + calls.inApp, 0);
});
test('snooze', async () => {
  const { transport } = mk();
  const r = await deliver({ user: U({ snoozedUntil: '2026-10-23T06:00:00Z' }), candidate: { id: 'c3', type: 'briefing' }, now: AM, transport, consentStore: consent });
  assert.equal(r.push, false); assert.equal(r.resumeAt, '2026-10-23T06:00:00.000Z');
});
test('category off / never asked / consent down / permission', async () => {
  const c = { id: 'c4', type: 'briefing' };
  let m = mk();
  let r = await deliver({ user: U({ categories: { briefing: false } }), candidate: c, now: AM, transport: m.transport, consentStore: consent });
  assert.equal(r.push || r.inApp, false);
  m = mk();
  r = await deliver({ user: U({ categories: undefined }), candidate: c, now: AM, transport: m.transport, consentStore: consent });
  assert.equal(m.calls.push, 0); assert.equal(r.inApp, true);
  m = mk();
  r = await deliver({ user: U(), candidate: c, now: AM, transport: m.transport, consentStore: { get: async () => { throw new Error('down'); } } });
  assert.equal(m.calls.push, 0); assert.ok(r.reason);
  m = mk();
  r = await deliver({ user: U({ notificationsPermitted: false }), candidate: c, now: AM, transport: m.transport, consentStore: consent });
  assert.equal(m.calls.push, 0); assert.equal(r.inApp, true);
});
test('push false falls back to in-app, retry does not duplicate', async () => {
  const calls = { push: 0, inApp: 0 };
  const transport = { push: async () => (calls.push++, false), inApp: async () => { calls.inApp++; } };
  const u = U(); const c = { id: 'c5', type: 'briefing' };
  const r = await deliver({ user: u, candidate: c, now: AM, transport, consentStore: consent });
  assert.equal(r.push, false); assert.equal(r.inApp, true); assert.ok(r.reason);
  await deliver({ user: u, candidate: c, now: AM, transport, consentStore: consent });
  assert.equal(calls.inApp, 1);
});
test('dismissal back-off', async () => {
  const u = U();
  for (let i = 0; i < 3; i++) await recordDismissal(u.id, 'briefing', Date.parse(AM) - (i + 1) * 3600e3);
  const { transport, calls } = mk();
  const r = await deliver({ user: u, candidate: { id: 'c6', type: 'briefing' }, now: AM, transport, consentStore: consent });
  assert.equal(calls.push, 0); assert.equal(r.inApp, true); assert.ok(r.resumeAt);
});
test('concurrent workers send once per candidate', async () => {
  const u = U({ id: 'shared' });
  const kids = Array.from({ length: 6 }, () => new Promise((res) => {
    const p = fork(fileURLToPath(new URL('./bot.worker.mjs', import.meta.url)), [JSON.stringify(u), AM], { env: process.env });
    let out = 0; p.on('message', (m) => (out = m)); p.on('exit', () => res(out));
  }));
  const sent = (await Promise.all(kids)).reduce((a, b) => a + b, 0);
  assert.equal(sent, 1);
});
