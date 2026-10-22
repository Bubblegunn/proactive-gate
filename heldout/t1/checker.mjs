// Usage: node checker.mjs <project-dir>   (dir contains src/gate.mjs and src/run.mjs)
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] || '.');
const data = p => JSON.parse(fs.readFileSync(path.join(here, 'fixture/data', p), 'utf8'));
const policy = data('policy.json'), areaCodes = data('area-codes.json');
const expected = JSON.parse(fs.readFileSync(path.join(here, 'expected/week.json'), 'utf8'));
let mod;
try { mod = await import(pathToFileURL(path.join(dir, 'src/gate.mjs')).href); } catch (e) { console.log('FAIL C0 cannot import src/gate.mjs: ' + e.message); process.exit(1); }
const evaluate = mod.evaluate;
if (typeof evaluate !== 'function') { console.log('FAIL C0 src/gate.mjs does not export evaluate'); process.exit(1); }

const base = { consent: { push: true, email: true, sms: true, chat: true }, optedOut: false, snoozedUntil: null, quiet: null, state: null, phone: '+447700900123' };
const U = (o) => ({ ...base, ...o });
const H = (userId, channel, at, status = 'sent') => ({ id: 'h' + Math.random(), userId, channel, at, status });
let seq = 0;
const ev = async (user, channel, at, { history = [], priority = 'normal' } = {}) => {
  const snapshot = JSON.stringify(history);
  const r = await evaluate({ id: 'x' + (++seq), userId: user.id, channel, priority, at }, { user, policy, areaCodes, history });
  if (JSON.stringify(history) !== snapshot) r.__mutated = true;
  return r;
};
const codes = r => (r.reasons || []).map(x => x.code);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const detailHas = (r, code, ...needles) => { const d = (r.reasons || []).find(x => x.code === code)?.detail; return typeof d === 'string' && needles.every(n => d.includes(n)); };

const results = [];
async function crit(id, name, fn) {
  const fails = [];
  const t = (cond, msg) => { if (!cond) fails.push(msg); };
  try { await fn(t); } catch (e) { fails.push('threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e)); }
  results.push(!fails.length);
  console.log(`${fails.length ? 'FAIL' : 'PASS'} ${id} ${name}`);
  for (const f of fails.slice(0, 8)) console.log('     - ' + f);
}
const allowedOf = async (u, ch, at, o) => (await ev(u, ch, at, o)).allowed === true;

await crit('C1', 'quiet hours in the recipient zone across DST and half-hour offsets, with retryAt', async t => {
  const lon = U({ id: 'lon', tz: 'Europe/London', quiet: { start: '22:00', end: '07:00' } });
  const ny = U({ id: 'ny', tz: 'America/New_York', quiet: { start: '22:00', end: '07:00' } });
  const kol = U({ id: 'kol', tz: 'Asia/Kolkata', quiet: { start: '23:30', end: '06:30' } });
  let r = await ev(lon, 'push', '2026-03-29T21:30:00Z');
  t(!r.allowed && eq(codes(r), ['quiet_hours']), 'London 21:30Z on 29 Mar is 22:30 BST and must be quiet_hours, got ' + JSON.stringify(codes(r)));
  t(detailHas(r, 'quiet_hours', '22:30', 'Europe/London'), 'quiet_hours detail must contain local time 22:30 and Europe/London');
  t(await allowedOf(lon, 'push', '2026-03-29T06:30:00Z'), 'London 06:30Z on 29 Mar is 07:30 BST and must be allowed');
  t(!(await allowedOf(lon, 'email', '2026-10-25T06:59:00Z')), 'London 06:59Z on 25 Oct is 06:59 GMT, quiet');
  t(await allowedOf(lon, 'email', '2026-10-25T07:00:00Z'), 'London 07:00Z on 25 Oct is 07:00 GMT, quiet end is exclusive');
  t(!(await allowedOf(ny, 'chat', '2026-03-08T10:59:00Z')), 'New York 10:59Z on 8 Mar is 06:59 EDT, quiet');
  t(await allowedOf(ny, 'chat', '2026-03-08T11:00:00Z'), 'New York 11:00Z on 8 Mar is 07:00 EDT, allowed');
  t(!(await allowedOf(ny, 'chat', '2026-11-01T11:59:00Z')), 'New York 11:59Z on 1 Nov is 06:59 EST, quiet');
  t(await allowedOf(ny, 'chat', '2026-11-01T12:00:00Z'), 'New York 12:00Z on 1 Nov is 07:00 EST, allowed');
  t(await allowedOf(kol, 'push', '2026-06-10T17:59:00Z'), 'Kolkata 17:59Z is 23:29, allowed');
  t(!(await allowedOf(kol, 'push', '2026-06-10T18:00:00Z')), 'Kolkata 18:00Z is 23:30, quiet start inclusive');
  r = await ev(ny, 'push', '2026-03-08T06:30:00Z');
  t(r.retryAt === '2026-03-08T11:00:00.000Z', 'retryAt across spring forward must be 2026-03-08T11:00:00.000Z, got ' + r.retryAt);
  for (const at of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) { r = await ev(ny, 'push', at); t(r.retryAt === '2026-11-01T12:00:00.000Z', `retryAt from ${at} must be 2026-11-01T12:00:00.000Z, got ${r.retryAt}`); }
  r = await ev(ny, 'push', '2026-06-10T15:00:00Z');
  t(r.allowed === true && r.retryAt === null && eq(r.reasons, []), 'an allowed message has reasons [] and retryAt null');
});

await crit('C2', 'legal contact window for sms: stricter state windows, area code vs saved zone, no bypass', async t => {
  const split = U({ id: 'split', tz: 'America/Los_Angeles', state: 'CA', phone: '+13055550101' });
  let r = await ev(split, 'sms', '2026-06-10T00:30:00Z');
  t(!r.allowed && eq(codes(r), ['legal_window']), 'saved zone LA 17:30 but Miami area code 20:30 (FL ends 20:00) must be legal_window, got ' + JSON.stringify(codes(r)));
  t(detailHas(r, 'legal_window', 'America/New_York', '20:30'), 'detail must name America/New_York and 20:30');
  t(await allowedOf(split, 'sms', '2026-06-09T23:30:00Z'), 'LA 16:30 / Miami 19:30 is inside both windows');
  r = await ev(split, 'sms', '2026-06-10T12:05:00Z');
  t(eq(codes(r), ['legal_window']) && detailHas(r, 'legal_window', 'America/Los_Angeles', '05:05'), 'LA 05:05 is before 08:00, detail must name America/Los_Angeles and 05:05');
  t(await allowedOf(split, 'push', '2026-06-10T00:30:00Z'), 'the legal window applies to sms only; push at the same instant is allowed');
  r = await ev(split, 'sms', '2026-06-10T00:30:00Z');
  t(r.retryAt === '2026-06-10T15:00:00.000Z', 'retryAt must be when both zones are inside 08:00 to 20:00 (LA 08:00 = 15:00Z), got ' + r.retryAt);
  const md = U({ id: 'md', tz: 'America/New_York', state: 'MD', phone: '+14105550101' });
  t(await allowedOf(md, 'sms', '2026-06-10T00:40:00Z'), 'Maryland 20:40 allowed (ends 20:45)');
  t(!(await allowedOf(md, 'sms', '2026-06-10T00:45:00Z')), 'Maryland 20:45 blocked (end exclusive)');
  const ok = U({ id: 'ok', tz: 'America/Chicago', state: 'OK', phone: '+14055550101' });
  t(await allowedOf(ok, 'sms', '2026-06-10T00:59:00Z'), 'Oklahoma 19:59 allowed');
  t(!(await allowedOf(ok, 'sms', '2026-06-10T01:00:00Z')), 'Oklahoma 20:00 blocked');
  const ny = U({ id: 'nyd', tz: 'America/New_York', state: 'NY', phone: '+12125550101' });
  t(await allowedOf(ny, 'sms', '2026-06-10T00:59:00Z'), 'default window: 20:59 allowed');
  t(!(await allowedOf(ny, 'sms', '2026-06-10T01:00:00Z')), 'default window: 21:00 blocked');
  t(!(await allowedOf(ny, 'sms', '2026-06-10T11:59:00Z')) && await allowedOf(ny, 'sms', '2026-06-10T12:00:00Z'), 'default window opens at 08:00 local');
  const az = U({ id: 'az', tz: 'America/Phoenix', state: 'AZ', phone: '+16025550101' });
  t(await allowedOf(az, 'sms', '2026-07-11T03:59:00Z'), 'Phoenix has no DST: 03:59Z is 20:59 MST, allowed');
  t(!(await allowedOf(az, 'sms', '2026-07-11T04:00:00Z')), 'Phoenix 04:00Z is 21:00 MST, blocked');
  const fl = U({ id: 'flny', tz: 'America/New_York', state: 'FL', phone: '+12125550101' });
  r = await ev(fl, 'sms', '2026-06-10T00:30:00Z');
  t(eq(codes(r), ['legal_window']) && detailHas(r, 'legal_window', '20:30'), 'saved state FL (20:00) applies even though the 212 area code is NY');
  const unk = U({ id: 'unk', tz: 'America/New_York', state: 'NY', phone: '+19995550101' });
  t(await allowedOf(unk, 'sms', '2026-06-10T00:59:00Z') && !(await allowedOf(unk, 'sms', '2026-06-10T01:00:00Z')), 'unknown area code falls back to the saved zone only');
  t(await allowedOf(U({ id: 'uk' }), 'sms', '2026-06-10T22:00:00Z'), 'a +44 number is not subject to the US window');
  r = await ev(ny, 'sms', '2026-06-10T01:00:00Z', { priority: 'critical' });
  t(eq(codes(r), ['legal_window']), 'critical priority must not bypass the legal window, got ' + JSON.stringify(codes(r)));
});

await crit('C3', 'rolling caps: 24h window not calendar day, 7 days, per channel, status and user filtering', async t => {
  const u = U({ id: 'capu', tz: 'America/Los_Angeles' });
  const noise = [1, 2, 3, 4, 5].map(i => H('other', 'push', `2026-06-10T0${i}:00:00Z`));
  const at = '2026-06-10T12:00:00Z';
  const base3 = [H('capu', 'push', '2026-06-09T12:00:00Z'), H('capu', 'push', '2026-06-09T12:00:01Z'), H('capu', 'email', '2026-06-10T03:00:00Z'), H('capu', 'chat', '2026-06-10T08:00:00Z'), ...noise];
  let r = await ev(u, 'push', at, { history: base3 });
  t(eq(codes(r), ['rolling_24h_cap']) && detailHas(r, 'rolling_24h_cap', '3'), 'three sends inside 24h (exactly-24h-old one excluded, other users ignored) must hit rolling_24h_cap, got ' + JSON.stringify(codes(r)));
  r = await ev(u, 'push', at, { history: base3.filter(h => h.at !== '2026-06-09T12:00:01Z') });
  t(r.allowed === true, 'a send exactly 24h earlier does not count, so two counted sends are allowed, got ' + JSON.stringify(codes(r)));
  r = await ev(u, 'push', at, { history: [...base3, H('capu', 'push', '2026-06-10T09:00:00Z')] });
  t(detailHas(r, 'rolling_24h_cap', '4', '3'), 'detail must state counted 4 and limit 3');
  r = await ev(u, 'push', '2026-06-10T14:00:00Z', { history: [H('capu', 'push', '2026-06-09T20:00:00Z'), H('capu', 'push', '2026-06-09T21:00:00Z'), H('capu', 'push', '2026-06-09T22:00:00Z')] });
  t(eq(codes(r), ['rolling_24h_cap']), 'three sends within the last 18 hours but on the previous local calendar day must still block, got ' + JSON.stringify(codes(r)));
  r = await ev(u, 'push', '2026-06-10T14:00:00Z', { history: [H('capu', 'push', '2026-06-10T06:30:00Z'), H('capu', 'push', '2026-06-10T08:00:00Z'), H('capu', 'push', '2026-06-10T10:00:00Z')] });
  t(eq(codes(r), ['rolling_24h_cap']), 'three sends in 24h must block even though only two fall on the local calendar day');
  r = await ev(u, 'push', at, { history: [H('capu', 'push', '2026-06-10T01:00:00Z', 'failed'), H('capu', 'push', '2026-06-10T02:00:00Z', 'blocked'), H('capu', 'push', '2026-06-10T03:00:00Z', 'failed'), H('capu', 'push', '2026-06-10T13:00:00Z'), H('capu', 'push', '2026-06-10T14:00:00Z'), H('capu', 'push', '2026-06-10T15:00:00Z')] });
  t(r.allowed === true, 'failed or blocked entries and entries after the candidate time do not count, got ' + JSON.stringify(codes(r)));
  const wk = ['2026-06-03T12:00:01Z', '2026-06-04T10:00:00Z', '2026-06-05T10:00:00Z', '2026-06-06T10:00:00Z', '2026-06-07T10:00:00Z', '2026-06-08T10:00:00Z', '2026-06-09T10:00:00Z', '2026-06-09T20:00:00Z'].map(a => H('capu', 'email', a));
  r = await ev(u, 'push', at, { history: wk });
  t(eq(codes(r), ['rolling_7d_cap']) && detailHas(r, 'rolling_7d_cap', '8'), '8 sends in 7 days must give exactly rolling_7d_cap, got ' + JSON.stringify(codes(r)));
  r = await ev(u, 'push', at, { history: [H('capu', 'email', '2026-06-03T12:00:00Z'), ...wk.slice(1)] });
  t(r.allowed === true, 'a send exactly 7 days earlier does not count (7 counted, limit 8), got ' + JSON.stringify(codes(r)));
  const s2 = [H('capu', 'sms', '2026-06-10T01:00:00Z'), H('capu', 'sms', '2026-06-10T02:00:00Z')];
  t(eq(codes(await ev(u, 'sms', at, { history: s2 })), ['channel_24h_cap']), 'two sms in 24h block a third sms with only channel_24h_cap');
  t((await ev(u, 'email', at, { history: s2 })).allowed === true, 'the sms channel cap does not block email');
  r = await ev(u, 'sms', at, { history: [...s2, H('capu', 'push', '2026-06-10T03:00:00Z')] });
  t(eq(codes(r), ['rolling_24h_cap', 'channel_24h_cap']), 'reasons keep the fixed order, got ' + JSON.stringify(codes(r)));
  t(eq(codes(await ev(u, 'email', at, { history: [...s2, H('capu', 'push', '2026-06-10T03:00:00Z')] })), ['rolling_24h_cap']), 'email with 3 sent: rolling_24h_cap only');
});

await crit('C4', 'consent, opt-out, snooze, critical priority, reason order and explanations', async t => {
  let r = await ev(U({ id: 'a', optedOut: true }), 'push', '2026-06-10T12:00:00Z');
  t(eq(codes(r), ['opted_out']), 'opted out gives exactly [opted_out], got ' + JSON.stringify(codes(r)));
  t(eq(codes(await ev(U({ id: 'b', consent: { push: true, sms: false } }), 'sms', '2026-06-10T12:00:00Z')), ['no_consent']), 'sms consent false gives [no_consent]');
  t(eq(codes(await ev(U({ id: 'b2', consent: { push: true } }), 'chat', '2026-06-10T12:00:00Z')), ['no_consent']), 'a missing channel key is not consent');
  const sn = U({ id: 'c', snoozedUntil: '2026-06-10T15:00:00Z' });
  r = await ev(sn, 'push', '2026-06-10T14:59:59Z');
  t(eq(codes(r), ['snoozed']) && detailHas(r, 'snoozed', '2026-06-10T15:00'), 'one second before the snooze end is snoozed and the detail names the end time');
  t(await allowedOf(sn, 'push', '2026-06-10T15:00:00Z'), 'at exactly the snooze end the message is allowed');
  const lon = U({ id: 'lon2', tz: 'Europe/London', quiet: { start: '22:00', end: '07:00' } });
  t(await allowedOf(lon, 'push', '2026-03-29T21:30:00Z', { priority: 'critical' }), 'critical priority bypasses quiet hours');
  t(eq(codes(await ev(U({ id: 'd', snoozedUntil: '2026-06-11T00:00:00Z' }), 'push', '2026-06-10T12:00:00Z', { priority: 'critical' })), ['snoozed']), 'critical does not bypass snooze');
  t(eq(codes(await ev(U({ id: 'e', optedOut: true }), 'push', '2026-06-10T12:00:00Z', { priority: 'critical' })), ['opted_out']), 'critical does not bypass opt-out');
  const multi = U({ id: 'm', optedOut: true, snoozedUntil: '2026-06-11T00:00:00Z', tz: 'UTC', quiet: { start: '22:00', end: '07:00' } });
  r = await ev(multi, 'push', '2026-06-10T23:00:00Z');
  t(eq(codes(r), ['opted_out', 'snoozed', 'quiet_hours']), 'all applicable reasons in fixed order, got ' + JSON.stringify(codes(r)));
  t(r.retryAt === null, 'retryAt is null when a non-window reason also applies');
  r = await ev(U({ id: 'f', tz: 'UTC', quiet: { start: '22:00', end: '07:00' } }), 'push', '2026-06-10T23:00:00Z', { history: [1, 2, 3].map(i => H('f', 'push', `2026-06-10T1${i}:00:00Z`)) });
  t(eq(codes(r), ['quiet_hours', 'rolling_24h_cap']) && r.retryAt === null, 'quiet plus cap: both reasons, retryAt null, got ' + JSON.stringify(codes(r)) + ' ' + r.retryAt);
  t((r.reasons || []).length > 0 && r.reasons.every(x => typeof x.code === 'string' && typeof x.detail === 'string' && x.detail.trim().length >= 8), 'every reason has a code and a human readable detail');
  const hist = [H('f', 'push', '2026-06-10T10:00:00Z')];
  const rr = await ev(U({ id: 'f' }), 'push', '2026-06-10T12:00:00Z', { history: hist });
  t(!rr.__mutated, 'evaluate must not mutate the history it is given');
});

await crit('C5', 'end to end: run.mjs replays the fixture week, calls send for allowed, explains every blocked message', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't1-'));
  fs.cpSync(dir, tmp, { recursive: true });
  fs.rmSync(path.join(tmp, 'out'), { recursive: true, force: true });
  const p = spawnSync(process.execPath, ['src/run.mjs'], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  t(p.status === 0, 'node src/run.mjs exited ' + p.status + ' ' + (p.stderr || '').slice(0, 300));
  const rd = f => { try { return fs.readFileSync(path.join(tmp, 'out', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return null; } };
  const sent = rd('sent.jsonl'), blocked = rd('blocked.jsonl');
  t(sent && blocked, 'out/sent.jsonl and out/blocked.jsonl must exist');
  if (sent && blocked) {
    const ids = sent.map(s => s.id);
    t(new Set(ids).size === ids.length, 'a candidate was sent more than once');
    t(eq(ids, expected.allowed), `sent ids differ from expected (got ${ids.length}, expected ${expected.allowed.length}); order is chronological by instant, ties by id`);
    const got = Object.fromEntries(blocked.map(b => [b.id, (b.reasons || []).map(x => x.code)]));
    t(Object.keys(got).length === Object.keys(expected.blocked).length, `blocked count ${Object.keys(got).length} vs expected ${Object.keys(expected.blocked).length}`);
    let bad = 0, first = '';
    for (const [id, c] of Object.entries(expected.blocked)) if (!eq(got[id], c)) { bad++; if (!first) first = `${id}: got ${JSON.stringify(got[id])} want ${JSON.stringify(c)}`; }
    t(bad === 0, `${bad} blocked messages have different reasons, first ${first}`);
    t(blocked.every(b => b.reasons?.length && b.reasons.every(r => r.detail && String(r.detail).trim())), 'every blocked line must carry reasons with non-empty detail');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const failed = results.filter(x => !x).length;
console.log(failed ? `\n${failed} of ${results.length} criteria failed` : `\nall ${results.length} criteria passed`);
process.exit(failed ? 1 : 0);
