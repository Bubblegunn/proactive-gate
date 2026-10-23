import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'gate-'));
const { decide, recordDismissal, optOut } = await import('./bot.mjs');

const flags = { proactiveEnabled: true };
const mk = (id, over = {}) => ({ id, timezone: 'Europe/Istanbul', deviceTimezone: null, consents: { marketing: true }, createdAt: '2026-01-01T00:00:00Z', ...over });
const cand = (id, type = 'checkin') => ({ id, type });
const at = (iso) => new Date(iso);
const noon = at('2026-10-23T09:00:00Z'); // 12:00 Istanbul

test('sends once, then not again the same day', async () => {
  const u = mk('a1');
  assert.deepEqual(await decide({ user: u, candidate: cand('c1'), now: noon, flags }), { send: true, reason: null });
  const r = await decide({ user: u, candidate: cand('c2'), now: at('2026-10-23T14:00:00Z'), flags });
  assert.equal(r.send, false);
  assert.equal((await decide({ user: u, candidate: cand('c3'), now: at('2026-10-24T09:00:00Z'), flags })).send, true);
});
test('kill switch, consent, missing consents', async () => {
  assert.equal((await decide({ user: mk('b1'), candidate: cand('c'), now: noon, flags: { proactiveEnabled: false } })).send, false);
  assert.equal((await decide({ user: mk('b2', { consents: { marketing: false } }), candidate: cand('c'), now: noon, flags })).send, false);
  assert.equal((await decide({ user: mk('b3', { consents: undefined }), candidate: cand('c'), now: noon, flags })).send, false);
  assert.equal((await decide({ user: mk('b4', { consents: { analytics: true } }), candidate: cand('c'), now: noon, flags })).send, false);
});
test('quiet hours use local zone; device zone wins; UTC placeholder unknown', async () => {
  const night = at('2026-10-23T01:00:00Z'); // 04:00 Istanbul, 18:00 Los Angeles prev day
  assert.equal((await decide({ user: mk('d1'), candidate: cand('c'), now: night, flags })).send, false);
  assert.equal((await decide({ user: mk('d2', { deviceTimezone: 'America/Los_Angeles' }), candidate: cand('c'), now: night, flags })).send, true);
  assert.equal((await decide({ user: mk('d3', { timezone: 'UTC' }), candidate: cand('c'), now: noon, flags })).send, false);
  assert.equal((await decide({ user: mk('d4', { timezone: 'UTC', deviceTimezone: 'Asia/Tokyo' }), candidate: cand('c'), now: at('2026-10-23T03:00:00Z'), flags })).send, true);
  assert.equal((await decide({ user: mk('d5', { timezone: 'Nope/Zone' }), candidate: cand('c'), now: noon, flags })).send, false);
  assert.equal((await decide({ user: mk('d6', { timezone: undefined }), candidate: cand('c'), now: noon, flags })).send, false);
});
test('opt-out is permanent and per type', async () => {
  const u = mk('e1');
  await optOut('e1', 'checkin');
  assert.equal((await decide({ user: u, candidate: cand('c'), now: noon, flags })).send, false);
  assert.equal((await decide({ user: u, candidate: cand('t', 'tip'), now: noon, flags })).send, true);
  assert.equal((await decide({ user: u, candidate: cand('c9'), now: at('2027-10-23T09:00:00Z'), flags })).send, false);
});
test('dismissal backs off then pauses', async () => {
  const u = mk('f1');
  await recordDismissal('f1', 'checkin', noon);
  assert.equal((await decide({ user: u, candidate: cand('c1'), now: at('2026-10-25T09:00:00Z'), flags })).send, false);
  assert.equal((await decide({ user: u, candidate: cand('c2'), now: at('2026-10-26T09:00:00Z'), flags })).send, true);
  await recordDismissal('f1', 'checkin', at('2026-10-26T10:00:00Z'));
  assert.equal((await decide({ user: u, candidate: cand('c3'), now: at('2026-11-01T09:00:00Z'), flags })).send, false);
  assert.equal((await decide({ user: u, candidate: cand('c4'), now: at('2026-11-03T09:00:00Z'), flags })).send, true);
  await recordDismissal('f1', 'checkin', at('2026-11-03T10:00:00Z'));
  await recordDismissal('f1', 'checkin', at('2026-12-04T10:00:00Z'));
  assert.equal((await decide({ user: u, candidate: cand('c5'), now: at('2027-01-20T09:00:00Z'), flags })).send, false);
});
test('concurrent processes send at most once', async () => {
  const code = `process.env.STATE_DIR=${JSON.stringify(process.env.STATE_DIR)};
    const {decide}=await import(${JSON.stringify(new URL('./bot.mjs', import.meta.url).href)});
    const r=await decide({user:${JSON.stringify(mk('g1'))},candidate:{id:'x'+process.pid,type:'checkin'},now:new Date('2026-10-23T09:00:00Z'),flags:{proactiveEnabled:true}});
    console.log(r.send);`;
  const runs = await Promise.all(Array.from({ length: 12 }, () => new Promise((res) => {
    let out = ''; const p = spawn(process.execPath, ['--input-type=module', '-e', code]);
    p.stdout.on('data', (d) => (out += d)); p.on('close', () => res(out.trim()));
  })));
  assert.equal(runs.filter((x) => x === 'true').length, 1, runs.join());
});
