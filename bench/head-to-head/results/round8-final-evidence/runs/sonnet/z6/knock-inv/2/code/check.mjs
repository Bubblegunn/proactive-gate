// Manual check script: node check.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

if (process.argv[2] === 'worker') {
  const { decide } = await import('./bot.mjs');
  const [, , , uid, tag] = process.argv;
  const user = { id: uid, timezone: 'America/New_York', consent: true };
  let sent = 0;
  for (let i = 0; i < 5; i++) {
    const r = await decide({ user, notification: { id: `${tag}-${i}` }, now: new Date('2026-06-10T16:00:00Z') });
    if (r.send) sent++;
  }
  console.log(sent);
  process.exit(0);
}

process.env.STATE_DIR = path.join(mkdtempSync(path.join(tmpdir(), 'gate-')), 'nested', 'state');
const { decide, whyNotReceived, dryRun } = await import('./bot.mjs');

const ny = { id: 'u1', timezone: 'America/New_York', consent: true };
const d = (user, id, iso) => decide({ user, notification: { id }, now: new Date(iso) });

// consent
assert.equal((await d({ ...ny, id: 'nc', consent: false }, 'a', '2026-06-10T16:00:00Z')).send, false);
// quiet hours: 21:59 local ok, 22:00 blocked, 07:59 blocked, 08:00 ok (EDT = UTC-4)
assert.equal((await d({ ...ny, id: 'q1' }, 'a', '2026-06-11T01:59:00Z')).send, true);
assert.equal((await d({ ...ny, id: 'q2' }, 'a', '2026-06-11T02:00:00Z')).send, false);
assert.equal((await d({ ...ny, id: 'q3' }, 'a', '2026-06-11T11:59:00Z')).send, false);
assert.equal((await d({ ...ny, id: 'q4' }, 'a', '2026-06-11T12:00:00Z')).send, true);
// cap: 3 per local day, 4th blocked, next local day resets (local midnight = 04:00Z)
for (const [i, t] of ['13:00', '14:00', '15:00', '16:00'].entries()) {
  assert.equal((await d(ny, `n${i}`, `2026-06-10T${t}:00Z`)).send, i < 3);
}
assert.equal((await d(ny, 'n5', '2026-06-11T12:00:00Z')).send, true);
// local day boundary: 23:30 local on Jun 10 is quiet; Tokyo user: cap counts Tokyo calendar day
const tk = { id: 'tk', timezone: 'Asia/Tokyo', consent: true };
for (const [i, t] of ['2026-06-10T00:00', '2026-06-10T01:00', '2026-06-10T02:00', '2026-06-10T03:00'].entries()) {
  assert.equal((await d(tk, `t${i}`, `${t}:00Z`)).send, i < 3);
}
assert.equal((await d(tk, 't9', '2026-06-10T23:00:00Z')).send, true); // Jun 11 08:00 JST, new day

// why
const why = await whyNotReceived({ userId: 'u1', from: '2026-06-10T00:00:00Z', to: '2026-06-10T23:59:00Z' });
assert.equal(why.length, 4);
assert.deepEqual(why.map((w) => w.delivered), [true, true, true, false]);
assert.equal(why[3].ruleCode, 'DAILY_CAP');
assert.equal(why[3].availableAt, '2026-06-11T12:00:00.000Z');
const wq = await whyNotReceived({ userId: 'q2', from: '2026-06-11T02:00:00Z', to: '2026-06-11T02:00:01Z' });
assert.equal(wq.length, 1);
assert.equal(wq[0].ruleCode, 'QUIET_HOURS');
assert.equal(wq[0].availableAt, '2026-06-11T12:00:00.000Z');
const wq2 = await whyNotReceived({ userId: 'q2', from: '2026-06-11T02:00:00Z', to: '2026-06-11T02:00:00Z' });
assert.equal(wq2.length, 0); // `to` exclusive
const wc = await whyNotReceived({ userId: 'nc', from: '2026-06-10T00:00:00Z', to: '2026-06-12T00:00:00Z' });
assert.equal(wc[0].ruleCode, 'NO_CONSENT');
assert.equal(wc[0].availableAt, null);
console.log(why[3].text, '\n', wq[0].text, '\n', wc[0].text, '\n', why[0].text);

// DST: Europe/Berlin, spring forward 2026-03-29. 22:30 local Mar 28 (CET, 21:30Z) -> resume 08:00 CEST = 06:00Z Mar 29
const be = { id: 'be', timezone: 'Europe/Berlin', consent: true };
await d(be, 'x', '2026-03-28T21:30:00Z');
const wb = await whyNotReceived({ userId: 'be', from: '2026-03-28T00:00:00Z', to: '2026-03-30T00:00:00Z' });
assert.equal(wb[0].availableAt, '2026-03-29T06:00:00.000Z');

// restart persistence + concurrent processes: 6 workers x 5 attempts, same user/day => exactly 3 sends
const run = (tag) => new Promise((res) => {
  const c = spawn(process.execPath, [path.join(here, 'check.mjs'), 'worker', 'shared', tag], { env: process.env });
  let out = '';
  c.stdout.on('data', (x) => (out += x));
  c.stderr.on('data', (x) => process.stderr.write(x));
  c.on('close', () => res(Number(out.trim())));
});
const sends = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(run));
assert.equal(sends.reduce((a, b) => a + b, 0), 3);
const wsh = await whyNotReceived({ userId: 'shared', from: '2026-06-10T00:00:00Z', to: '2026-06-11T00:00:00Z' });
assert.equal(wsh.length, 30);
// a fresh process still sees the count
assert.equal(await new Promise((res) => {
  const c = spawn(process.execPath, [path.join(here, 'check.mjs'), 'worker', 'shared', 'g'], { env: process.env });
  let out = ''; c.stdout.on('data', (x) => (out += x)); c.on('close', () => res(Number(out.trim())));
}), 0);

// dryRun: no state change, correct counts
const before = readdirSync(path.join(process.env.STATE_DIR, 'users')).length;
const ev = (id, iso, u = { id: 'dr', timezone: 'UTC', consent: true }) => ({ user: u, notification: { id }, at: iso });
const events = [
  ev('1', '2026-06-01T09:00:00Z'), ev('2', '2026-06-01T10:00:00Z'), ev('3', '2026-06-01T11:00:00Z'),
  ev('4', '2026-06-01T12:00:00Z'), ev('5', '2026-06-01T23:00:00Z'), ev('6', '2026-06-02T06:00:00Z'),
  ev('7', '2026-06-01T09:00:00Z', { id: 'nc2', timezone: 'UTC', consent: false }),
];
assert.deepEqual(await dryRun({ events, policy: { quietHours: { start: '22:00', end: '08:00' }, dailyCap: 3 } }), { delivered: 3, blocked: 4 });
assert.deepEqual(await dryRun({ events, policy: { quietHours: null, dailyCap: null } }), { delivered: 6, blocked: 1 });
assert.deepEqual(await dryRun({ events, policy: { quietHours: { start: '23:00', end: '07:00' }, dailyCap: 5 } }), { delivered: 4, blocked: 3 });
assert.equal(readdirSync(path.join(process.env.STATE_DIR, 'users')).length, before);
console.log('ALL OK');
