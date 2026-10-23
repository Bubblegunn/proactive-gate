import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.STATE_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'bot-'));
const { deliver, recordDismissal } = await import('./bot.mjs');
if (process.argv[2] === 'worker') {
  const { appendFileSync } = await import('node:fs');
  const lg = path.join(process.env.STATE_DIR, 'sends.log');
  await deliver({ user: { id: 'w', timezone: 'America/New_York', categories: {}, snoozedUntil: null, platform: 'ios', notificationsPermitted: true },
    candidate: { id: 'wb', type: 'briefing' }, now: '2026-10-23T12:00:00Z',
    transport: { push: async () => { await new Promise((r) => setTimeout(r, 50)); appendFileSync(lg, 'push\n'); return true; }, inApp: async () => { appendFileSync(lg, 'inApp\n'); } },
    consentStore: { get: async () => ({ push: true }) } });
  process.exit(0);
}

const mk = (over = {}) => {
  const calls = { push: 0, inApp: 0 };
  return { calls, transport: {
    push: async () => { calls.push++; return over.pushResult ?? true; },
    inApp: async () => { calls.inApp++; },
  } };
};
const consent = { get: async () => ({ push: true }) };
const U = (id, o = {}) => ({ id, timezone: 'America/New_York', categories: { briefing: true }, snoozedUntil: null, platform: 'ios', notificationsPermitted: true, ...o });
const run = (user, cand, now, t = mk(), cs = consent) => deliver({ user, candidate: cand, now, transport: t.transport, consentStore: cs }).then((r) => [r, t.calls]);
const B = (id) => ({ id, type: 'briefing' });
const NOON_UTC_8AM_NY = '2026-10-23T12:00:00Z';

let [r, c] = await run(U('a'), B('b1'), NOON_UTC_8AM_NY);
assert.deepEqual(r, { push: true, inApp: true, reason: null, resumeAt: null });
[r, c] = await run(U('a'), B('b1'), NOON_UTC_8AM_NY); // retry: no resend
assert.equal(c.push + c.inApp, 0); assert.equal(r.push, true);
[r] = await run(U('a'), B('b2'), '2026-10-23T13:00:00Z'); // second briefing same day
assert.equal(r.push, false); assert.equal(r.inApp, false); assert.equal(r.resumeAt, '2026-10-24T11:00:00.000Z');

[r, c] = await run(U('c'), B('x'), '2026-10-23T08:00:00Z'); // 4am NY
assert.equal(r.push || r.inApp, false); assert.equal(r.resumeAt, '2026-10-23T11:00:00.000Z'); assert.equal(c.push, 0);
[r] = await run(U('d'), B('x'), '2026-10-23T16:00:00Z'); // noon NY, too late
assert.equal(r.resumeAt, '2026-10-24T11:00:00.000Z');
[r] = await run(U('e', { snoozedUntil: '2026-10-23T13:30:00Z' }), B('x'), NOON_UTC_8AM_NY);
assert.equal(r.push || r.inApp, false); assert.equal(r.resumeAt, '2026-10-23T13:30:00.000Z');
[r] = await run(U('f', { snoozedUntil: '2026-10-23T05:00:00Z' }), B('x'), NOON_UTC_8AM_NY); // expired snooze
assert.equal(r.push, true);
[r, c] = await run(U('g', { categories: { briefing: false } }), B('x'), NOON_UTC_8AM_NY);
assert.equal(r.push || r.inApp, false); assert.equal(c.push + c.inApp, 0);
[r, c] = await run(U('h', { notificationsPermitted: false }), B('x'), NOON_UTC_8AM_NY);
assert.deepEqual([r.push, r.inApp, c.push], [false, true, 0]); assert.ok(r.reason);
[r] = await run(U('i'), B('x'), NOON_UTC_8AM_NY, mk({ pushResult: false }));
assert.deepEqual([r.push, r.inApp], [false, true]); assert.ok(r.reason);
[r, c] = await run(U('j'), B('x'), NOON_UTC_8AM_NY, mk(), { get: async () => { throw new Error('down'); } });
assert.deepEqual([r.push, r.inApp, c.push], [false, true, 0]);
[r, c] = await run(U('k'), B('x'), NOON_UTC_8AM_NY, mk(), { get: async () => ({ push: false }) });
assert.equal(c.push, 0);
[r] = await run(U('l', { timezone: 'Nope/Zone' }), B('x'), NOON_UTC_8AM_NY); assert.equal(r.push, false);

// dismissals
for (let i = 0; i < 3; i++) await recordDismissal('m', 'briefing', `2026-10-2${i}T10:00:00Z`);
[r, c] = await run(U('m'), B('x'), NOON_UTC_8AM_NY);
assert.deepEqual([r.push, r.inApp, c.push], [false, true, 0]); assert.equal(r.resumeAt, '2026-11-03T10:00:00.000Z');
[r] = await run(U('m'), { id: 'tip1', type: 'tips' }, '2026-10-23T15:00:00Z'); // other type unaffected
assert.equal(r.inApp, true);

// DST: Europe/Berlin fall-back day 2026-10-25, 07:00 local = 06:00Z
[r] = await run(U('n', { timezone: 'Europe/Berlin' }), B('x'), '2026-10-25T04:00:00Z');
assert.equal(r.resumeAt, '2026-10-25T06:00:00.000Z');

// concurrency: 8 processes, same user + candidate => one push, one in-app
const log = path.join(process.env.STATE_DIR, 'sends.log');
const here = fileURLToPath(import.meta.url);
const kids = await Promise.all(Array.from({ length: 8 }, () => new Promise((res) => {
  const k = fork(here, ['worker'], { env: process.env }); k.on('exit', res);
})));
const { readFileSync } = await import('node:fs');
const lines = readFileSync(log, 'utf8').trim().split('\n');
assert.equal(lines.filter((l) => l === 'push').length, 1, lines.join());
assert.equal(lines.filter((l) => l === 'inApp').length, 1);
console.log('ok');
