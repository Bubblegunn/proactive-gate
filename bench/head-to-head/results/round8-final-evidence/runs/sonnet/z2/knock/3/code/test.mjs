import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === 'worker') {
  const { trySend } = await import('./bot.mjs');
  const r = await trySend({ user: { id: 'race', timezone: 'America/New_York' },
    message: { id: 'm1', channel: 'sms', createdAt: '2026-10-23T15:00:00Z' }, now: new Date('2026-10-23T16:00:00Z') });
  process.send(r); process.exit(0);
}
process.env.STATE_DIR = join(mkdtempSync(join(tmpdir(), 'st-')), 'nested');
const { trySend, handleInbound, optOut } = await import('./bot.mjs');
const msg = (id) => ({ id, channel: 'sms', createdAt: '2026-10-23T15:00:00Z' });
const u = (id, tz = 'America/New_York') => ({ id, timezone: tz });
const T = (s) => new Date(s);

// quiet hours: 12:00Z = 08:00 EDT ok, 11:59Z = 07:59 blocked, 00:00Z = 20:00 EDT blocked, 23:59Z = 19:59 ok
assert.equal((await trySend({ user: u('a'), message: msg('1'), now: T('2026-10-23T11:59:00Z') })).sent, false);
assert.equal((await trySend({ user: u('a'), message: msg('1'), now: T('2026-10-24T00:00:00Z') })).sent, false);
assert.equal((await trySend({ user: u('a'), message: msg('1'), now: T('2026-10-23T23:59:00Z') })).sent, true);
// redelivery
assert.equal((await trySend({ user: u('a'), message: msg('1'), now: T('2026-10-24T14:00:00Z') })).sent, false);
// weekly cap, then ok after 6 days
assert.equal((await trySend({ user: u('a'), message: msg('2'), now: T('2026-10-24T14:00:00Z') })).sent, false);
assert.equal((await trySend({ user: u('a'), message: msg('3'), now: T('2026-10-30T14:00:00Z') })).sent, true);
// time zone: Pacific 15:00Z = 08:00 PDT ok, 14:59Z blocked
assert.equal((await trySend({ user: u('p', 'America/Los_Angeles'), message: msg('1'), now: T('2026-10-23T14:59:00Z') })).sent, false);
assert.equal((await trySend({ user: u('p', 'America/Los_Angeles'), message: msg('1'), now: T('2026-10-23T15:00:00Z') })).sent, true);
// bad zone / bad input
assert.equal((await trySend({ user: u('z', 'Nowhere/Land'), message: msg('1'), now: T('2026-10-23T16:00:00Z') })).sent, false);
assert.equal((await trySend({ user: { id: 'z' }, message: msg('1'), now: T('2026-10-23T16:00:00Z') })).sent, false);
// inbound STOP variants
const noon = T('2026-10-23T16:00:00Z');
for (const [i, t] of ['STOP', ' stop. ', 'Unsubscribe', 'please stop texting me', 'QUIT', 'Opt out'].entries()) {
  const id = 's' + i;
  const r = await handleInbound({ userId: id, channel: 'sms', text: t, now: noon });
  assert.match(r.reply, /unsubscribed/);
  assert.equal((await trySend({ user: u(id), message: msg('1'), now: noon })).sent, false, t);
}
// START resubscribes, HELP/other no state change
assert.match((await handleInbound({ userId: 's0', channel: 'sms', text: 'start', now: noon })).reply, /subscribed/);
assert.equal((await trySend({ user: u('s0'), message: msg('1'), now: noon })).sent, true);
assert.equal((await handleInbound({ userId: 'h', channel: 'sms', text: 'thanks!', now: noon })).reply, null);
assert.match((await handleInbound({ userId: 'h', channel: 'sms', text: 'HELP', now: noon })).reply, /STOP/);
// account page opt-out
await optOut('acct', 'sms');
assert.equal((await trySend({ user: u('acct'), message: msg('1'), now: noon })).sent, false);
// multi-process race: 8 workers, same message, exactly one send
const res = await Promise.all(Array.from({ length: 8 }, () => new Promise((ok) => {
  const c = fork(fileURLToPath(import.meta.url), ['worker']); c.on('message', ok);
})));
assert.equal(res.filter((r) => r.sent).length, 1);
console.log('all tests passed');
