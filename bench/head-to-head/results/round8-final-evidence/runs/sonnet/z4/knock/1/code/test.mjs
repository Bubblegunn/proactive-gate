import { decide, REASON_CODES } from './bot.mjs';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.argv[2] === 'worker') {
  const [, , , uid, cid, origin] = process.argv;
  const r = await decide({ user: { id: uid, timezone: 'Europe/Istanbul', createdAt: '2026-01-01T00:00:00Z', profileCreatedAt: '2026-01-01T00:00:00Z' }, candidate: { id: cid, origin }, now: new Date('2026-10-23T09:00:00Z'), config: { dailyNudgeCap: 2 } });
  console.log(JSON.stringify(r)); process.exit(0);
}
process.env.STATE_DIR = path.join(os.tmpdir(), 'bot-test-' + Date.now());
const old = { id: 'u1', timezone: 'Europe/Istanbul', createdAt: '2026-01-01T00:00:00Z', profileCreatedAt: '2026-01-02T00:00:00Z' };
const nw = { id: 'u2', timezone: 'UTC', createdAt: '2026-10-23T08:00:00Z', profileCreatedAt: '2026-10-23T08:00:00Z' };
const cfg = { dailyNudgeCap: 2 };
const d = (user, id, origin, iso) => decide({ user, candidate: { id, origin }, now: new Date(iso), config: cfg });
// new user: requested ok, inferred blocked
assert.equal((await d(nw, 'a', 'requested', '2026-10-23T10:00:00Z')).send, true);
assert.equal((await d(nw, 'a', 'requested', '2026-10-23T10:01:00Z')).reasonCode, 'already_delivered');
assert.equal((await d(nw, 'b', 'inferred', '2026-10-23T12:00:00Z')).reasonCode, 'new_user_grace_period');
assert.equal((await d(nw, 'r', 'reminder', '2026-10-23T03:00:00Z')).send, true);
// old user: quiet hours (Istanbul UTC+3: 02:00Z = 05:00 local)
assert.equal((await d(old, 'i1', 'inferred', '2026-10-23T02:00:00Z')).reasonCode, 'quiet_hours');
assert.equal((await d(old, 'i1', 'inferred', '2026-10-23T07:00:00Z')).send, true);
assert.equal((await d(old, 'i2', 'inferred', '2026-10-23T08:00:00Z')).reasonCode, 'too_soon_after_last_nudge');
assert.equal((await d(old, 'i2', 'inferred', '2026-10-23T12:00:00Z')).send, true);
assert.equal((await d(old, 'i3', 'inferred', '2026-10-23T17:00:00Z')).reasonCode, 'daily_limit_reached');
assert.equal((await d(old, 'i3', 'inferred', '2026-10-24T08:00:00Z')).send, true);
assert.equal((await d(old, 'q', 'requested', '2026-10-23T23:30:00Z')).send, true);
assert.equal((await decide({ user: old, candidate: { id: 'x', origin: 'weird' }, now: new Date(), config: cfg })).send, false);
// concurrency: 12 processes, same inferred-user, cap 2 -> at most 1 sent (gap), requested all sent, same id once
const run = (uid, cid, origin) => new Promise((res) => { const p = spawn('node', ['test.mjs', 'worker', uid, cid, origin], { env: process.env }); let o = ''; p.stdout.on('data', (x) => o += x); p.on('close', () => res(JSON.parse(o))); });
const out = await Promise.all([...Array(12)].map((_, i) => run('cu', 'n' + i, 'inferred')).concat([...Array(6)].map(() => run('cu', 'same', 'requested'))));
const inf = out.slice(0, 12).filter((r) => r.send).length, req = out.slice(12).filter((r) => r.send).length;
assert.equal(inf, 1); assert.equal(req, 1);
for (const r of out) assert.ok(REASON_CODES.includes(r.reasonCode));
console.log('all ok', { inf, req });
