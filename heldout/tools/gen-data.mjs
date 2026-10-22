// Deterministic fixture generator. Run: node tools/gen-data.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000, WEEK0 = Date.UTC(2026, 2, 4);
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');
function withOffset(ms, offMin) {
  if (offMin === 0) return iso(ms);
  const d = new Date(ms + offMin * 60000).toISOString().slice(0, 19);
  const a = Math.abs(offMin);
  return d + (offMin < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
}
const AREA = {
  '212': { tz: 'America/New_York', state: 'NY' }, '305': { tz: 'America/New_York', state: 'FL' },
  '850': { tz: 'America/Chicago', state: 'FL' }, '405': { tz: 'America/Chicago', state: 'OK' },
  '410': { tz: 'America/New_York', state: 'MD' }, '202': { tz: 'America/New_York', state: 'DC' },
  '312': { tz: 'America/Chicago', state: 'IL' }, '415': { tz: 'America/Los_Angeles', state: 'CA' },
  '310': { tz: 'America/Los_Angeles', state: 'CA' }, '602': { tz: 'America/Phoenix', state: 'AZ' },
  '303': { tz: 'America/Denver', state: 'CO' }, '808': { tz: 'Pacific/Honolulu', state: 'HI' },
  '713': { tz: 'America/Chicago', state: 'TX' }, '206': { tz: 'America/Los_Angeles', state: 'WA' },
};
const TEMPL = [
  { tz: 'America/New_York', state: 'NY', ac: '212' }, { tz: 'America/New_York', state: 'FL', ac: '305' },
  { tz: 'America/Chicago', state: 'FL', ac: '850' }, { tz: 'America/Chicago', state: 'OK', ac: '405' },
  { tz: 'America/New_York', state: 'MD', ac: '410' }, { tz: 'America/Los_Angeles', state: 'CA', ac: '415' },
  { tz: 'America/Los_Angeles', state: 'CA', ac: '305' }, { tz: 'America/New_York', state: 'NY', ac: '310' },
  { tz: 'America/Phoenix', state: 'AZ', ac: '602' }, { tz: 'America/Denver', state: 'CO', ac: '303' },
  { tz: 'Pacific/Honolulu', state: 'HI', ac: '808' }, { tz: 'America/Chicago', state: 'TX', ac: '713' },
  { tz: 'America/Chicago', state: 'OK', ac: '312' }, { tz: 'America/New_York', state: 'MD', ac: '202' },
  { tz: 'Europe/London', state: null, cc: '+44' }, { tz: 'Asia/Kolkata', state: null, cc: '+91' },
  { tz: 'Europe/Berlin', state: null, cc: '+49' },
];
function makeUsers(n, r, t3) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const T = TEMPL[Math.floor(r() * TEMPL.length)];
    const phone = T.ac ? `+1${T.ac}555${1000 + Math.floor(r() * 9000)}` : `${T.cc}${10000000 + Math.floor(r() * 89999999)}`;
    const u = { id: 'u' + String(i + 1).padStart(3, '0'), tz: T.tz, state: T.state, phone,
      consent: { push: r() < .95, email: r() < .8, sms: r() < .75, chat: r() < .6 },
      optedOut: r() < .03, snoozedUntil: r() < .08 ? iso(WEEK0 + Math.floor(r() * 7 * DAY)) : null };
    const q = r();
    if (q < .55) u.quiet = { start: '22:00', end: '07:00' };
    else if (q < .7) u.quiet = { start: '23:30', end: '06:30' };
    else if (q < .85 || !t3) u.quiet = null;
    out.push(u);
  }
  return out;
}
function shuffle(a, r) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function makeCandidates(n, users, r, mixOffsets, prefix) {
  const heavy = users.filter(() => r() < .2).map(u => u.id);
  const offs = [0, 0, 60, -300, -240, 330];
  const out = [];
  for (let i = 0; i < n; i++) {
    const uid = r() < .55 && heavy.length ? heavy[Math.floor(r() * heavy.length)] : users[Math.floor(r() * users.length)].id;
    const x = r();
    const channel = x < .3 ? 'sms' : x < .65 ? 'push' : x < .85 ? 'email' : 'chat';
    const ms = WEEK0 + Math.floor(r() * 7) * DAY + Math.floor(r() * 24) * 3600000 + Math.floor(r() * 60) * 60000;
    const at = mixOffsets ? withOffset(ms, offs[Math.floor(r() * offs.length)]) : iso(ms);
    out.push({ id: prefix + String(i + 1).padStart(4, '0'), userId: uid, channel, priority: r() < .06 ? 'critical' : 'normal', at, body: 'reminder ' + (i + 1) });
  }
  return out;
}
function makeHistory(users, r, prefix) {
  const out = []; let k = 0;
  const heavy = users.filter(() => r() < .25);
  for (let i = 0; i < 170; i++) {
    const u = heavy[Math.floor(r() * heavy.length)] || users[0];
    const ch = ['sms', 'push', 'email', 'chat'][Math.floor(r() * 4)];
    out.push({ id: prefix + String(++k).padStart(4, '0'), userId: u.id, channel: ch, at: iso(WEEK0 - Math.floor(r() * 7 * DAY)), status: r() < .1 ? 'failed' : 'sent' });
  }
  for (let i = 0; i < 40; i++) {
    const u = heavy[Math.floor(r() * heavy.length)] || users[0];
    out.push({ id: prefix + String(++k).padStart(4, '0'), userId: u.id, channel: ['sms', 'push', 'email'][Math.floor(r() * 3)], at: iso(WEEK0 - Math.floor(r() * 22 * 3600000)), status: 'sent' });
  }
  return out;
}
const jl = a => a.map(x => JSON.stringify(x)).join('\n') + '\n';
const put = (p, s) => { mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); writeFileSync(path.join(root, p), s); };
const pj = o => JSON.stringify(o, null, 1) + '\n';
const AREAJ = pj(AREA);
const legal = { default: { start: '08:00', end: '21:00' }, FL: { start: '08:00', end: '20:00' }, OK: { start: '08:00', end: '20:00' }, MD: { start: '08:00', end: '20:45' } };
const notes = [
  'Federal default: TCPA, 47 CFR 64.1200(c)(1), no telephone solicitation before 8am or after 9pm at the called party location.',
  'Florida: Fla. Stat. 501.059(8)(a), 8am to 8pm.',
  'Oklahoma: Telephone Solicitation Act, 8am to 8pm.',
  'Maryland: Stop the Spam Calls Act, Md. Code Com. Law 14-4501 and following, 8am to 8:45pm.',
  'Windows are start inclusive, end exclusive. Figures are as supplied by the product owner for this exercise; counsel must confirm before production use.',
];
// ---- T1
{
  const r = rng(1101); const users = makeUsers(40, r, false);
  put('t1/fixture/data/users.json', pj(users)); put('t1/fixture/data/area-codes.json', AREAJ);
  put('t1/fixture/data/policy.json', pj({ legal, caps: { rolling24h: 3, rolling7d: 8, channel24h: { sms: 2 } }, notes }));
  put('t1/fixture/data/candidates.jsonl', jl(shuffle(makeCandidates(350, users, r, false, 'c'), r)));
  put('t1/fixture/data/history-before.jsonl', jl(makeHistory(users, r, 'h')));
}
// ---- T3
{
  const r = rng(3303); const users = makeUsers(60, r, true);
  put('t3/fixture/data/users.json', pj(users)); put('t3/fixture/data/area-codes.json', AREAJ);
  const cur = { quietDefault: { start: '23:00', end: '06:00' }, legal, caps: { rolling24h: 3, rolling7d: 8, channel24h: { sms: 2 } }, notes };
  const prop = { quietDefault: { start: '21:00', end: '08:00' }, legal: { ...legal, MD: { start: '08:00', end: '20:00' } }, caps: { rolling24h: 2, rolling7d: 8, channel24h: { sms: 2 } }, notes };
  put('t3/fixture/data/policy.current.json', pj(cur)); put('t3/fixture/data/policy.proposed.json', pj(prop));
  const cands = makeCandidates(2000, users, r, true, 'm');
  const dups = []; for (let i = 0; i < 40; i++) dups.push(cands[Math.floor(r() * cands.length)]);
  put('t3/fixture/data/candidates.jsonl', jl(shuffle([...cands, ...dups], r)));
  put('t3/fixture/data/history-before.jsonl', jl(makeHistory(users, r, 'h')));
  const ev = []; const smsU = users.filter(u => u.consent.sms);
  for (let i = 0; i < 90; i++) {
    const u = smsU[Math.floor(r() * smsU.length)]; const ms = WEEK0 + Math.floor(r() * 7 * DAY) + Math.floor(r() * 24) * 3600000;
    const x = r();
    if (x < .45) { ev.push({ at: iso(ms), userId: u.id, type: 'stop' }); if (r() < .4) ev.push({ at: iso(ms + (1 + Math.floor(r() * 30)) * 3600000), userId: u.id, type: 'start' }); }
    else if (x < .9) { const uu = users[Math.floor(r() * users.length)]; ev.push({ at: iso(ms), userId: uu.id, type: 'snooze', until: iso(ms + (1 + Math.floor(r() * 30)) * 3600000) }); }
    else ev.push({ at: iso(ms), userId: u.id, type: 'optout' });
  }
  put('t3/fixture/data/events.jsonl', jl(shuffle(ev, r)));
}
// ---- T2
{
  const r = rng(2202); const users = [];
  const tz = ['America/Los_Angeles', 'America/New_York', 'Europe/London', 'America/Chicago', 'UTC'];
  for (let i = 0; i < 12; i++) users.push({ id: 'u' + String(i + 1).padStart(3, '0'), tz: tz[i % tz.length], quiet: i % 3 === 2 ? null : { start: '21:00', end: '08:00' }, consent: { push: true, email: true, sms: i % 4 !== 3 }, phone: '+1415555' + (1000 + i) });
  put('t2/fixture/data/users.json', pj(users));
  put('t2/fixture/data/policy.json', pj({ caps: { rolling24h: 3 }, notes: ['One rolling 24 hour cap across all channels. STOP applies to sms only.'] }));
  put('t2/fixture/data/inbound.jsonl', jl([
    { at: '2026-06-10T12:03:00Z', userId: 'u001', channel: 'sms', body: 'STOP' },
    { at: '2026-06-10T12:05:00Z', userId: 'u002', channel: 'sms', body: 'please do not stop sending these' },
    { at: '2026-06-10T13:00:00Z', userId: 'u001', channel: 'sms', body: 'start' },
  ]));
}
const pkg = name => pj({ name, private: true, type: 'module', engines: { node: '>=22' } });
put('t1/fixture/package.json', pkg('reminder-service')); put('t2/fixture/package.json', pkg('dispatch-service')); put('t3/fixture/package.json', pkg('policy-replay'));
const stub1 = `import { appendFileSync, mkdirSync } from 'node:fs';
const out = new URL('./out/', import.meta.url);
export async function send(message) {
  mkdirSync(out, { recursive: true });
  appendFileSync(new URL('sent.jsonl', out), JSON.stringify({ ...message, recordedBy: 'stub' }) + '\\n');
  return { providerId: 'stub-' + message.id };
}
`;
put('t1/fixture/send.mjs', stub1);
put('t2/fixture/provider.mjs', `// Stub of the vendor client. The real vendor drops a second call that carries an
// Idempotency-Key it has already seen (within 24h) and returns the original providerId.
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
const out = new URL('./out/', import.meta.url);
export async function send(message, { idempotencyKey } = {}) {
  mkdirSync(out, { recursive: true });
  const file = new URL('sent.jsonl', out);
  if (idempotencyKey && existsSync(file)) {
    const seen = readFileSync(file, 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l)).find(r => r.idempotencyKey === idempotencyKey);
    if (seen) return { providerId: seen.providerId, deduped: true };
  }
  const providerId = 'stub-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  appendFileSync(file, JSON.stringify({ ...message, idempotencyKey, providerId }) + '\\n');
  return { providerId };
}
`);
console.log('ok');
