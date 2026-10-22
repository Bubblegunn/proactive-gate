// Usage: node checker.mjs <project-dir>   (dir contains src/replay.mjs exporting compareWeek, and src/report.mjs)
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] || '.');
const fx = p => path.join(here, 'fixture/data', p);
const rj = p => JSON.parse(fs.readFileSync(fx(p), 'utf8'));
const rl = p => fs.readFileSync(fx(p), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const expected = JSON.parse(fs.readFileSync(path.join(here, 'expected/week.json'), 'utf8'));
let mod;
try { mod = await import(pathToFileURL(path.join(dir, 'src/replay.mjs')).href); } catch (e) { console.log('FAIL C0 cannot import src/replay.mjs: ' + e.message); process.exit(1); }
const compareWeek = mod.compareWeek;
if (typeof compareWeek !== 'function') { console.log('FAIL C0 src/replay.mjs does not export compareWeek'); process.exit(1); }
const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const eq = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const codes = o => (o?.reasons || []).map(x => x.code);
const areaCodes = rj('area-codes.json');
const results = [];
async function crit(id, name, fn) {
  const fails = [];
  const t = (cond, msg) => { if (!cond) fails.push(msg); };
  try { await fn(t); } catch (e) { fails.push('threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
  results.push(!fails.length);
  console.log(`${fails.length ? 'FAIL' : 'PASS'} ${id} ${name}`);
  for (const f of fails.slice(0, 8)) console.log('     - ' + f);
}
const U = o => ({ tz: 'UTC', state: null, phone: '+447700900123', consent: { push: true, email: true, sms: true, chat: true }, optedOut: false, snoozedUntil: null, ...o });
const C = (id, userId, at, channel = 'push', priority = 'normal') => ({ id, userId, channel, priority, at });
const byId = r => Object.fromEntries(r.messages.map(m => [m.id, m]));
const noEvents = { events: [], history: [] };

await crit('C1', 'what-if on quiet-hour default and cap: explicit null vs missing, cascade, instant ordering, duplicates, exact numbers', async t => {
  const users = [U({ id: 'U1' }), U({ id: 'U2', quiet: null }), U({ id: 'U3', tz: 'America/New_York' }), U({ id: 'U4', quiet: null })];
  const candidates = [
    C('m8', 'U3', '2026-03-11T13:00:00Z'), C('m9b', 'U4', '2026-03-10T23:20:00Z'), C('m1', 'U1', '2026-03-10T23:00:00Z'), C('m2', 'U1', '2026-03-11T00:30:00+01:00'),
    C('m3', 'U1', '2026-03-11T09:00:00Z'), C('m4', 'U2', '2026-03-10T23:00:00Z'), C('m5', 'U2', '2026-03-10T23:30:00Z'), C('m6', 'U2', '2026-03-10T23:45:00Z'),
    C('m7', 'U3', '2026-03-11T03:00:00Z'), C('m9a', 'U4', '2026-03-11T00:15:00+01:00'), C('m1', 'U1', '2026-03-10T23:00:00Z'),
  ];
  const legal = { default: { start: '08:00', end: '21:00' } };
  const baselinePolicy = { quietDefault: null, legal, caps: { rolling24h: 2, rolling7d: 100, channel24h: {} } };
  const proposedPolicy = { quietDefault: { start: '22:00', end: '07:00' }, legal, caps: { rolling24h: 1, rolling7d: 100, channel24h: {} } };
  const usersCopy = JSON.stringify(users), candCopy = JSON.stringify(candidates);
  const r = await compareWeek({ candidates, ...noEvents, users, areaCodes, baselinePolicy, proposedPolicy });
  t(r.total === 10 && r.duplicatesDropped === 1, `total 10 and duplicatesDropped 1, got ${r.total} and ${r.duplicatesDropped}`);
  t(r.baseline?.sent === 8 && r.baseline?.blocked === 2 && eq(r.baseline?.byReason, { rolling_24h_cap: 2 }), 'baseline: 8 sent, 2 blocked, {rolling_24h_cap:2}, got ' + JSON.stringify(r.baseline));
  t(r.proposed?.sent === 4 && r.proposed?.blocked === 6 && eq(r.proposed?.byReason, { quiet_hours: 3, rolling_24h_cap: 3 }), 'proposed: 4 sent, 6 blocked, {quiet_hours:3, rolling_24h_cap:3}, got ' + JSON.stringify(r.proposed));
  t(eq(r.messages?.map(m => m.id), ['m1', 'm4', 'm9a', 'm9b', 'm2', 'm5', 'm6', 'm7', 'm3', 'm8']), 'messages must be ordered by instant then id, got ' + JSON.stringify(r.messages?.map(m => m.id)));
  t(eq(r.newlyBlocked, ['m1', 'm9b', 'm2', 'm5', 'm7']), 'newlyBlocked, got ' + JSON.stringify(r.newlyBlocked));
  t(eq(r.newlyAllowed, ['m3']), 'newlyAllowed must contain m3 (freed by the cascade), got ' + JSON.stringify(r.newlyAllowed));
  const m = byId(r);
  t(m.m1 && m.m1.proposed.outcome === 'blocked' && eq(codes(m.m1.proposed), ['quiet_hours']) && m.m1.proposed.reasons[0].detail.includes('23:00') && m.m1.proposed.reasons[0].detail.includes('UTC'), 'm1 proposed: quiet_hours with local time 23:00 and UTC in the detail');
  t(m.m5 && eq(codes(m.m5.proposed), ['rolling_24h_cap']) && /\b1\b/.test(m.m5.proposed.reasons[0].detail), 'm5 proposed: rolling_24h_cap, detail states the count and limit');
  t(m.m4 && m.m4.proposed.outcome === 'sent' && eq(m.m4.proposed.reasons, []), 'U2 has quiet:null (no quiet hours by choice) and must not pick up the new default');
  t(m.m9a && m.m9a.proposed.outcome === 'sent' && m.m9b.proposed.outcome === 'blocked', 'the +01:00 timestamp is the earlier instant and gets the slot, not the string that sorts first');
  t(m.m7 && eq(codes(m.m7.proposed), ['quiet_hours']) && m.m7.proposed.reasons[0].detail.includes('23:00') && m.m7.proposed.reasons[0].detail.includes('America/New_York'), 'm7 is 23:00 in New York after the DST change, not 22:00');
  t(JSON.stringify(users) === usersCopy && JSON.stringify(candidates) === candCopy, 'inputs must not be mutated');
});

await crit('C2', 'timeline of STOP, START, snooze and opt-out events; ties apply the event first; each policy run starts from the same state', async t => {
  const users = [U({ id: 'U5', quiet: null }), U({ id: 'U6', quiet: null })];
  const events = [
    { at: '2026-06-10T12:00:00Z', userId: 'U5', type: 'start' }, { at: '2026-06-10T10:00:00Z', userId: 'U5', type: 'stop' },
    { at: '2026-06-10T13:00:00Z', userId: 'U5', type: 'snooze', until: '2026-06-10T15:00:00Z' }, { at: '2026-06-10T08:00:00Z', userId: 'U6', type: 'optout' },
  ];
  const candidates = [
    C('s6', 'U5', '2026-06-10T15:00:00Z', 'sms'), C('s5', 'U5', '2026-06-10T13:30:00Z', 'sms'), C('s4', 'U5', '2026-06-10T12:00:00Z', 'sms'), C('s3', 'U5', '2026-06-10T11:00:00Z', 'sms'),
    C('p1', 'U5', '2026-06-10T11:00:00Z', 'push'), C('s2', 'U5', '2026-06-10T10:00:00Z', 'sms'), C('s1', 'U5', '2026-06-10T09:59:59Z', 'sms'),
    C('o2', 'U6', '2026-06-10T08:00:00Z'), C('o1', 'U6', '2026-06-10T07:59:00Z'),
  ];
  const policy = { quietDefault: null, legal: { default: { start: '08:00', end: '21:00' } }, caps: { rolling24h: 100, rolling7d: 100, channel24h: {} } };
  const usersCopy = JSON.stringify(users);
  const r = await compareWeek({ candidates, events, history: [], users, areaCodes, baselinePolicy: policy, proposedPolicy: JSON.parse(JSON.stringify(policy)) });
  t(eq(r.messages?.map(m => m.id), ['o1', 'o2', 's1', 's2', 'p1', 's3', 's4', 's5', 's6']), 'order by instant then id, got ' + JSON.stringify(r.messages?.map(m => m.id)));
  const want = { o1: [], o2: ['opted_out'], s1: [], s2: ['no_consent'], p1: [], s3: ['no_consent'], s4: [], s5: ['snoozed'], s6: [] };
  const m = byId(r);
  for (const [id, c] of Object.entries(want)) {
    for (const side of ['baseline', 'proposed']) t(m[id] && eq(codes(m[id][side]), c) && m[id][side].outcome === (c.length ? 'blocked' : 'sent'), `${id} ${side} should be ${JSON.stringify(c)}, got ${JSON.stringify(m[id] && codes(m[id][side]))}`);
  }
  t(r.proposed?.sent === 5 && r.proposed?.blocked === 4 && eq(r.proposed?.byReason, { no_consent: 2, snoozed: 1, opted_out: 1 }), 'proposed totals, got ' + JSON.stringify(r.proposed));
  t(eq(r.newlyBlocked, []) && eq(r.newlyAllowed, []), 'identical policies change nothing');
  t(JSON.stringify(users) === usersCopy, 'users must not be mutated by applying events');
  t(m.s5 && m.s5.proposed.reasons?.[0]?.detail?.includes('2026-06-10T15:00'), 'snoozed detail names the end of the snooze as set by the event');
});

await crit('C3', 'legal-window what-if with an area code that disagrees with the saved zone, and per-message explanation', async t => {
  const users = [U({ id: 'LS', tz: 'America/Los_Angeles', state: 'CA', phone: '+13055550101', quiet: null })];
  const legal = { default: { start: '08:00', end: '21:00' }, FL: { start: '08:00', end: '20:00' } };
  const caps = { rolling24h: 100, rolling7d: 100, channel24h: {} };
  const r = await compareWeek({ candidates: [C('l2', 'LS', '2026-06-11T00:30:00Z', 'sms'), C('l1', 'LS', '2026-06-10T23:45:00Z', 'sms')], ...noEvents, users, areaCodes,
    baselinePolicy: { quietDefault: null, legal, caps }, proposedPolicy: { quietDefault: null, legal: { ...legal, FL: { start: '08:00', end: '19:30' } }, caps } });
  const m = byId(r);
  t(m.l1 && m.l1.baseline.outcome === 'sent' && m.l1.proposed.outcome === 'blocked' && eq(codes(m.l1.proposed), ['legal_window']), 'l1: allowed today, blocked by the proposed FL 19:30 end');
  t(m.l1 && m.l1.proposed.reasons?.[0]?.detail?.includes('America/New_York') && m.l1.proposed.reasons[0].detail.includes('19:45'), 'l1 detail must name America/New_York and 19:45, got ' + m.l1?.proposed.reasons?.[0]?.detail);
  t(m.l2 && eq(codes(m.l2.baseline), ['legal_window']) && eq(codes(m.l2.proposed), ['legal_window']), 'l2 is blocked under both policies');
  t(eq(r.newlyBlocked, ['l1']) && eq(r.newlyAllowed, []), 'newlyBlocked [l1], got ' + JSON.stringify(r.newlyBlocked));
  t(r.baseline?.sent === 1 && r.proposed?.sent === 0 && eq(r.proposed?.byReason, { legal_window: 2 }), 'summaries, got ' + JSON.stringify([r.baseline, r.proposed]));
});

await crit('C4', 'the fixture week (2000 rows, 40 duplicates, mixed UTC offsets, events, prior history): totals, reasons and every message', async t => {
  const input = { candidates: rl('candidates.jsonl'), events: rl('events.jsonl'), history: rl('history-before.jsonl'), users: rj('users.json'), areaCodes, baselinePolicy: rj('policy.current.json'), proposedPolicy: rj('policy.proposed.json') };
  const t0 = Date.now();
  const r = await compareWeek(input);
  const ms = Date.now() - t0;
  t(ms < 20000, `replay took ${ms} ms, limit 20000`);
  t(r.total === expected.total && r.duplicatesDropped === expected.duplicatesDropped, `total ${r.total} dup ${r.duplicatesDropped}, expected ${expected.total} and ${expected.duplicatesDropped}`);
  t(eq(r.baseline, expected.baseline), 'baseline summary differs, got ' + JSON.stringify(r.baseline) + ' expected ' + JSON.stringify(expected.baseline));
  t(eq(r.proposed, expected.proposed), 'proposed summary differs, got ' + JSON.stringify(r.proposed) + ' expected ' + JSON.stringify(expected.proposed));
  const m = r.messages || [];
  t(eq(m.map(x => x.id), expected.order), 'message order differs from instant then id');
  let bad = 0, first = '';
  for (const x of m) {
    if (!eq(codes(x.proposed), expected.proposedCodes[x.id]) || !eq(codes(x.baseline), expected.baselineCodes[x.id])) { bad++; if (!first) first = `${x.id} got ${JSON.stringify(codes(x.baseline))}/${JSON.stringify(codes(x.proposed))} want ${JSON.stringify(expected.baselineCodes[x.id])}/${JSON.stringify(expected.proposedCodes[x.id])}`; }
  }
  t(bad === 0, `${bad} messages have different reasons, first ${first}`);
  t(eq(r.newlyBlocked, expected.newlyBlocked) && eq(r.newlyAllowed, expected.newlyAllowed), `newlyBlocked ${r.newlyBlocked?.length}/${expected.newlyBlocked.length}, newlyAllowed ${r.newlyAllowed?.length}/${expected.newlyAllowed.length} or order differs`);
  const sum = Object.values(r.proposed?.byReason || {}).reduce((a, b) => a + b, 0);
  t(sum === r.proposed?.blocked && r.proposed?.sent + r.proposed?.blocked === r.total, 'byReason must sum to blocked and sent + blocked must equal total');
  t(m.every(x => x.proposed.outcome === 'sent' ? x.proposed.reasons.length === 0 : x.proposed.reasons.length > 0 && x.proposed.reasons.every(q => q.code && typeof q.detail === 'string' && q.detail.trim().length >= 8)), 'every blocked message has reasons with a code and a readable detail; sent has none');
});

await crit('C5', 'report.mjs: stdout answers "how many blocked, by reason" and out/per-message.jsonl explains every message', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't3-'));
  fs.cpSync(dir, tmp, { recursive: true });
  fs.rmSync(path.join(tmp, 'out'), { recursive: true, force: true });
  const t0 = Date.now();
  const p = spawnSync(process.execPath, ['src/report.mjs', 'data/policy.current.json', 'data/policy.proposed.json'], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  t(p.status === 0, 'node src/report.mjs exited ' + p.status + ' ' + (p.stderr || '').slice(0, 300));
  t(Date.now() - t0 < 30000, 'report took too long');
  const lines = (p.stdout || '').split('\n');
  for (const [code, n] of Object.entries(expected.proposed.byReason)) t(lines.some(l => l.includes(code) && new RegExp(`(^|\\D)${n}(\\D|$)`).test(l.replace(code, ''))), `stdout needs a line with ${code} and the count ${n}`);
  t((p.stdout || '').includes(String(expected.proposed.blocked)) && (p.stdout || '').includes(String(expected.proposed.sent)), `stdout must state sent ${expected.proposed.sent} and blocked ${expected.proposed.blocked} under the proposed policy`);
  t((p.stdout || '').includes(String(expected.total)), 'stdout states the number of unique messages replayed');
  let rows = null;
  try { rows = fs.readFileSync(path.join(tmp, 'out/per-message.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
  t(rows && rows.length === expected.total, `out/per-message.jsonl needs one row per unique message (${expected.total}), got ${rows && rows.length}`);
  if (rows) {
    const ids = new Set(rows.map(x => x.id));
    t(ids.size === rows.length && expected.order.every(id => ids.has(id)), 'row ids are unique and cover every message');
    t(rows.every(x => eq((x.reasons || []).map(q => q.code), expected.proposedCodes[x.id])), 'each row carries the proposed-policy reasons (code list identical to the oracle)');
    t(rows.every(x => ['sent', 'blocked'].includes(x.outcome) && (x.outcome === 'sent' || x.reasons.every(q => String(q.detail || '').trim()))), 'each row has outcome sent or blocked and blocked rows have detail text');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const failed = results.filter(x => !x).length;
console.log(failed ? `\n${failed} of ${results.length} criteria failed` : `\nall ${results.length} criteria passed`);
process.exit(failed ? 1 : 0);
