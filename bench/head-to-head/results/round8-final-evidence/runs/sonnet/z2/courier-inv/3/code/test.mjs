import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[2] === 'child') {
  const { trySend } = await import('./bot.mjs');
  const r = await trySend({ user: { id: 'u-race', timezone: 'America/New_York' }, message: { id: 'm1', channel: 'sms', createdAt: '' }, now: new Date('2026-10-21T16:00:00Z') });
  console.log(r.sent); process.exit(0);
}
process.env.STATE_DIR = path.join(mkdtempSync(path.join(tmpdir(), 'st-')), 'new');
const { trySend, handleInbound, optOut } = await import('./bot.mjs');
const u = { id: 'u1', timezone: 'America/Los_Angeles' };
const m = (id) => ({ id, channel: 'sms', createdAt: '2026-10-21T00:00:00Z' });
const noon = new Date('2026-10-21T19:00:00Z'); // 12:00 PT
assert.equal((await trySend({ user: u, message: m('a'), now: noon })).sent, true);
assert.equal((await trySend({ user: u, message: m('a'), now: noon })).sent, false); // redelivery
assert.equal((await trySend({ user: u, message: m('b'), now: new Date(+noon + 864e5) })).sent, false); // too soon
assert.equal((await trySend({ user: u, message: m('c'), now: new Date(+noon + 7 * 864e5) })).sent, true);
const u2 = { id: 'u2', timezone: 'America/New_York' };
assert.equal((await trySend({ user: u2, message: m('q'), now: new Date('2026-10-21T01:30:00Z') })).sent, false); // 9:30pm ET
assert.equal((await trySend({ user: u2, message: m('q'), now: new Date('2026-10-21T11:59:00Z') })).sent, false); // 7:59am
assert.equal((await trySend({ user: u2, message: m('q'), now: new Date('2026-10-21T12:00:00Z') })).sent, true); // 8:00am
assert.equal((await trySend({ user: { id: 'u3', timezone: 'Nope/Zone' }, message: m('z'), now: noon })).sent, false);
// STOP variants
for (const t of ['stop', ' Stop. ', 'STOPALL', 'please stop texting me', 'Unsubscribe', 'quit']) {
  const id = 'x' + t; await handleInbound({ userId: id, channel: 'sms', text: t, now: noon });
  assert.equal((await trySend({ user: { id, timezone: 'America/Chicago' }, message: m('s'), now: noon })).sent, false, t);
}
assert.equal((await handleInbound({ userId: 'h', channel: 'sms', text: 'what is the end date', now: noon })).action, 'none');
assert.equal((await handleInbound({ userId: 'h', channel: 'sms', text: 'HELP', now: noon })).action, 'help');
// START resubscribes; account-page optOut blocks
await handleInbound({ userId: 'r', channel: 'sms', text: 'STOP', now: noon });
await handleInbound({ userId: 'r', channel: 'sms', text: 'start', now: noon });
assert.equal((await trySend({ user: { id: 'r', timezone: 'UTC' }, message: m('s'), now: noon })).sent, true);
await optOut('o', 'sms');
assert.equal((await trySend({ user: { id: 'o', timezone: 'UTC' }, message: m('s'), now: noon })).sent, false);
// multi-process race: exactly one wins
const outs = await Promise.all(Array.from({ length: 12 }, () => new Promise((res) => {
  let o = ''; const c = spawn('node', [path.join(here, 'test.mjs'), 'child'], { env: process.env });
  c.stdout.on('data', (d) => (o += d)); c.on('close', () => res(o.trim()));
})));
assert.equal(outs.filter((x) => x === 'true').length, 1, outs.join());
// restart persistence: child above is a fresh process; re-check from this one
assert.equal((await trySend({ user: { id: 'u-race', timezone: 'America/New_York' }, message: m('m1'), now: new Date('2026-10-21T16:00:00Z') })).sent, false);
console.log('all ok');
