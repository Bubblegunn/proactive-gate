import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);

if (process.argv[2] === 'worker') {
  const { decide } = await import('./bot.mjs');
  const user = JSON.parse(process.argv[3]);
  const out = [];
  for (let i = 0; i < 5; i++) {
    out.push(
      await decide({
        user,
        candidate: { id: `${process.pid}-${i}`, origin: 'inferred' },
        now: new Date('2026-10-01T09:00:00Z'),
        config: { dailyNudgeCap: 2 },
      }),
    );
  }
  process.send(out.filter((d) => d.send).length);
  process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), 'bot-'));
process.env.STATE_DIR = dir;
const { decide, REASON_CODES } = await import('./bot.mjs');

const old = { id: 'old', timezone: 'Europe/Istanbul', createdAt: '2026-01-01T00:00:00Z', profileCreatedAt: '2026-01-02T00:00:00Z' };
const cfg = { dailyNudgeCap: 3 };
const run = async (u, c, n, g = cfg) => {
  const d = await decide({ user: u, candidate: c, now: new Date(n), config: g });
  if (!d.send) assert.ok(REASON_CODES.includes(d.reasonCode), d.reasonCode);
  return d;
};
const inf = (id) => ({ id, origin: 'inferred' });

// Istanbul is UTC+3; 09:00Z = 12:00 local.
assert.equal((await run(old, inf('a'), '2026-10-01T09:00:00Z')).send, true);
assert.equal((await run(old, inf('a'), '2026-10-01T15:00:00Z')).reasonCode, 'already_delivered');
assert.equal((await run(old, inf('b'), '2026-10-01T10:00:00Z')).reasonCode, 'nudge_too_soon_after_last');
assert.equal((await run(old, inf('b'), '2026-10-01T13:00:00Z')).send, true);
assert.equal((await run(old, inf('c'), '2026-10-01T17:30:00Z')).send, true); // 20:30 local
assert.equal((await run(old, inf('d'), '2026-10-01T18:00:00Z')).reasonCode, 'quiet_hours'); // 21:00 local
assert.equal((await run(old, inf('e'), '2026-10-02T04:00:00Z')).reasonCode, 'quiet_hours'); // 07:00 local
// next local day, cap resets
assert.equal((await run(old, inf('f'), '2026-10-02T06:00:00Z')).send, true); // 09:00 local
// cap reached: 2 more allowed (cap 3)
assert.equal((await run(old, inf('g'), '2026-10-02T10:00:00Z')).send, true);
assert.equal((await run(old, inf('h'), '2026-10-02T14:30:00Z')).send, true);
assert.equal((await run(old, inf('i'), '2026-10-02T18:00:00Z')).reasonCode, 'quiet_hours');
assert.equal((await run(old, inf('j'), '2026-10-03T06:00:00Z', { dailyNudgeCap: 0 })).reasonCode, 'nudges_disabled');
assert.equal((await run(old, inf('k'), '2026-10-03T06:00:00Z', {})).reasonCode, 'nudges_disabled');

// cap of 2 reached in same day
const u2 = { ...old, id: 'u2' };
await run(u2, inf('1'), '2026-10-01T06:00:00Z', { dailyNudgeCap: 2 });
await run(u2, inf('2'), '2026-10-01T10:00:00Z', { dailyNudgeCap: 2 });
assert.equal((await run(u2, inf('3'), '2026-10-01T14:30:00Z', { dailyNudgeCap: 2 })).reasonCode, 'daily_nudge_cap_reached');

// New user: nothing inferred in grace; requested/reminder still go out
const fresh = { id: 'fresh', timezone: 'UTC', createdAt: '2026-10-01T00:00:00Z', profileCreatedAt: '2026-10-01T00:05:00Z' };
assert.equal((await run(fresh, inf('n1'), '2026-10-01T12:00:00Z')).reasonCode, 'new_user_grace_period');
assert.deepEqual(await run(fresh, { id: 'r1', origin: 'requested' }, '2026-10-01T23:00:00Z'), { send: true, reasonCode: 'requested_ready' });
assert.deepEqual(await run(fresh, { id: 'm1', origin: 'reminder' }, '2026-10-01T03:00:00Z'), { send: true, reasonCode: 'reminder_due' });
assert.equal((await run(fresh, { id: 'r1', origin: 'requested' }, '2026-10-02T10:00:00Z')).reasonCode, 'already_delivered');
// New user after grace: one nudge per day
assert.equal((await run(fresh, inf('n2'), '2026-10-04T12:00:00Z')).send, true);
assert.equal((await run(fresh, inf('n3'), '2026-10-04T17:00:00Z')).reasonCode, 'new_user_nudge_limit_reached');
assert.equal((await run(fresh, inf('n4'), '2026-10-05T12:00:00Z')).send, true);
// bad input
assert.equal((await run({ ...old, id: 'bad', timezone: 'Nope/Zone', createdAt: 'x' }, inf('z'), '2026-10-04T12:00:00Z')).reasonCode, 'new_user_grace_period');
assert.equal((await run(old, { id: 'q', origin: 'weird' }, '2026-10-04T12:00:00Z')).reasonCode, 'unknown_origin');

// Persistence across restart + concurrency across processes: 4 workers x 5 tries, same user, cap 2
const user = { id: 'shared', timezone: 'UTC', createdAt: '2026-01-01T00:00:00Z', profileCreatedAt: '2026-01-01T00:00:00Z' };
const counts = await Promise.all(
  [0, 1, 2, 3].map(
    () =>
      new Promise((resolve, reject) => {
        const p = fork(self, ['worker', JSON.stringify(user)], { env: process.env });
        p.on('message', resolve);
        p.on('error', reject);
      }),
  ),
);
const total = counts.reduce((a, b) => a + b, 0);
assert.equal(total, 1, `expected 1 nudge from 20 concurrent attempts (min gap), got ${total}`);

console.log('all checks passed');
