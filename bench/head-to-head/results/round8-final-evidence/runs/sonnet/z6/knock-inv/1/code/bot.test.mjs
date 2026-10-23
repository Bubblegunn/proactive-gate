import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

process.env.STATE_DIR = await mkdtemp(join(tmpdir(), 'bot-state-'));
const { decide, whyNotReceived, dryRun } = await import('./bot.mjs');

const ny = (id) => ({ id, timezone: 'America/New_York', consent: true });
// 2026-10-23 is EDT (UTC-4): 16:00Z = 12:00 local.
const at = (iso) => new Date(iso);

test('consent is required', async () => {
  const r = await decide({ user: { ...ny('c1'), consent: false }, notification: { id: 'n' }, now: at('2026-10-23T16:00:00Z') });
  assert.deepEqual(r, { send: false });
  const why = await whyNotReceived({ userId: 'c1', from: '2026-10-23T00:00:00Z', to: '2026-10-24T00:00:00Z' });
  assert.equal(why[0].ruleCode, 'NO_CONSENT');
  assert.equal(why[0].availableAt, null);
});

test('quiet hours boundaries in local time', async () => {
  const u = ny('q1');
  const d = async (iso, id) => (await decide({ user: u, notification: { id }, now: at(iso) })).send;
  assert.equal(await d('2026-10-24T01:59:59Z', 'a'), true); // 21:59:59 local
  assert.equal(await d('2026-10-24T02:00:00Z', 'b'), false); // 22:00 local
  assert.equal(await d('2026-10-24T11:59:59Z', 'c'), false); // 07:59:59 local
  assert.equal(await d('2026-10-24T12:00:00Z', 'd'), true); // 08:00 local
  const why = await whyNotReceived({ userId: 'q1', from: '2026-10-24T00:00:00Z', to: '2026-10-25T00:00:00Z' });
  assert.equal(why[1].ruleCode, 'QUIET_HOURS');
  assert.equal(why[1].availableAt, '2026-10-24T12:00:00.000Z');
  assert.equal(why[2].availableAt, '2026-10-24T12:00:00.000Z');
  assert.deepEqual(why.map((w) => w.notificationId), ['a', 'b', 'c', 'd']);
});

test('daily cap of 3 per local day, resets at local midnight', async () => {
  const u = { id: 'cap1', timezone: 'Asia/Tokyo', consent: true }; // UTC+9
  const sends = [];
  for (let i = 0; i < 5; i++) {
    sends.push((await decide({ user: u, notification: { id: `n${i}` }, now: at(`2026-10-23T0${i}:00:00Z`) })).send); // 09:00-13:00 JST
  }
  assert.deepEqual(sends, [true, true, true, false, false]);
  // 14:59Z = 23:59 JST is quiet hours; 15:00Z = 00:00 JST next day is quiet; 23:00Z = 08:00 JST next day is a new day.
  assert.equal((await decide({ user: u, notification: { id: 'next' }, now: at('2026-10-23T23:00:00Z') })).send, true);
  const why = await whyNotReceived({ userId: 'cap1', from: '2026-10-23T00:00:00Z', to: '2026-10-23T23:30:00Z' });
  assert.equal(why[3].ruleCode, 'DAILY_CAP');
  assert.equal(why[3].availableAt, '2026-10-23T23:00:00.000Z'); // next day 00:00 JST is quiet, so 08:00 JST
  assert.equal(why[5].delivered, true);
  for (const w of why) assert.equal(typeof w.text, 'string');
});

test('whyNotReceived range: from inclusive, to exclusive', async () => {
  const u = ny('r1');
  await decide({ user: u, notification: { id: 'x' }, now: at('2026-10-23T16:00:00Z') });
  assert.equal((await whyNotReceived({ userId: 'r1', from: '2026-10-23T16:00:00Z', to: '2026-10-23T16:00:01Z' })).length, 1);
  assert.equal((await whyNotReceived({ userId: 'r1', from: '2026-10-23T15:00:00Z', to: '2026-10-23T16:00:00Z' })).length, 0);
  assert.equal((await whyNotReceived({ userId: 'nobody', from: '2026-10-23T15:00:00Z', to: '2026-10-23T16:00:00Z' })).length, 0);
});

test('dryRun applies a candidate policy and touches no state', async () => {
  const before = await readdir(join(process.env.STATE_DIR, 'decisions'));
  const events = [];
  for (let i = 0; i < 6; i++) events.push({ user: ny('d1'), notification: { id: `e${i}` }, at: `2026-10-23T${12 + i}:00:00Z` }); // 08:00-13:00 local
  events.push({ user: ny('d1'), notification: { id: 'late' }, at: '2026-10-24T03:00:00Z' }); // 23:00 local
  events.push({ user: { ...ny('d2'), consent: false }, notification: { id: 'nc' }, at: '2026-10-23T16:00:00Z' });
  assert.deepEqual(await dryRun({ events, policy: { quietHours: { start: '22:00', end: '08:00' }, dailyCap: 3 } }), { delivered: 3, blocked: 5 });
  assert.deepEqual(await dryRun({ events, policy: { quietHours: null, dailyCap: null } }), { delivered: 7, blocked: 1 });
  assert.deepEqual(await dryRun({ events, policy: { quietHours: { start: '23:30', end: '07:00' }, dailyCap: 10 } }), { delivered: 7, blocked: 1 });
  assert.deepEqual(await dryRun({ events, policy: { quietHours: null, dailyCap: 0 } }), { delivered: 0, blocked: 8 });
  assert.deepEqual(await readdir(join(process.env.STATE_DIR, 'decisions')), before);
});

test('DST: cap day follows the local calendar day', async () => {
  // America/New_York falls back on 2026-11-01; that local day has 25 hours.
  const u = ny('dst1');
  const s = [];
  for (const iso of ['2026-11-01T13:00:00Z', '2026-11-01T14:00:00Z', '2026-11-01T15:00:00Z', '2026-11-01T16:00:00Z']) {
    s.push((await decide({ user: u, notification: { id: iso }, now: at(iso) })).send);
  }
  assert.deepEqual(s, [true, true, true, false]);
});

test('several worker processes share state without exceeding the cap', async () => {
  const code = `
    process.env.STATE_DIR = ${JSON.stringify(process.env.STATE_DIR)};
    const { decide } = await import(${JSON.stringify(new URL('./bot.mjs', import.meta.url).href)});
    let sent = 0;
    for (let i = 0; i < 6; i++) {
      const r = await decide({ user: { id: 'mp', timezone: 'Europe/Berlin', consent: true }, notification: { id: process.pid + '-' + i }, now: new Date('2026-10-23T10:00:00Z') });
      if (r.send) sent++;
    }
    console.log(sent);
  `;
  const run = () =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', code]);
      let out = '';
      p.stdout.on('data', (b) => (out += b));
      p.stderr.on('data', (b) => process.stderr.write(b));
      p.on('exit', (c) => (c === 0 ? resolve(Number(out.trim())) : reject(new Error(`exit ${c}`))));
    });
  const sent = await Promise.all(Array.from({ length: 8 }, run));
  assert.equal(sent.reduce((a, b) => a + b, 0), 3);
  const why = await whyNotReceived({ userId: 'mp', from: '2026-10-23T00:00:00Z', to: '2026-10-24T00:00:00Z' });
  assert.equal(why.length, 48);
  assert.equal(why.filter((w) => w.delivered).length, 3);
});
