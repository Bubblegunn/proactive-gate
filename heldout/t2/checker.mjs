// Usage: node checker.mjs <project-dir>   (dir contains src/dispatcher.mjs exporting createDispatcher)
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const dir = path.resolve(process.argv[2] || '.');
let mod;
try { mod = await import(pathToFileURL(path.join(dir, 'src/dispatcher.mjs')).href); } catch (e) { console.log('FAIL C0 cannot import src/dispatcher.mjs: ' + e.message); process.exit(1); }
const { createDispatcher } = mod;
if (typeof createDispatcher !== 'function') { console.log('FAIL C0 createDispatcher is not exported'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const AT = '2026-06-10T12:00:00Z';
const base = { consent: { push: true, email: true, sms: true }, quiet: null, tz: 'UTC' };
const mkUser = (id, o = {}) => ({ ...base, id, phone: '+14155550000', ...o });
const tmpState = () => fs.mkdtempSync(path.join(os.tmpdir(), 't2-'));
const pol = n => ({ caps: { rolling24h: n } });

// Vendor test double. Honors idempotency keys like the real vendor. Can deliver then fail (lost response),
// or fail before delivering. Records the order in which send() calls begin.
function makeProvider({ latency = 0 } = {}) {
  const p = { deliveries: [], calls: [], seq: 0, byKey: new Map(), crashAfter: new Set(), failBefore: new Set() };
  p.seqNow = () => p.seq;
  p.send = async (msg, opts = {}) => {
    const key = opts.idempotencyKey;
    const callSeq = ++p.seq;
    p.calls.push({ id: msg.id, userId: msg.userId, channel: msg.channel, key, callSeq });
    if (p.failBefore.has(msg.id)) { p.failBefore.delete(msg.id); throw new Error('network error before delivery'); }
    if (latency) await sleep(latency);
    if (key && p.byKey.has(key)) return p.byKey.get(key);
    const rec = { providerId: 'p' + (p.deliveries.length + 1) };
    p.deliveries.push({ id: msg.id, userId: msg.userId, channel: msg.channel, callSeq });
    if (key) p.byKey.set(key, rec);
    if (p.crashAfter.has(msg.id)) { p.crashAfter.delete(msg.id); throw new Error('process crashed after delivery'); }
    return rec;
  };
  return p;
}
const msg = (id, userId, channel = 'push', at = AT, extra = {}) => ({ id, userId, channel, at, body: 'hi ' + id, priority: 'normal', ...extra });
const settle = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));
const codes = r => (r.reasons || []).map(x => x.code);
const nDel = (prov, id) => prov.deliveries.filter(d => d.id === id).length;

const results = [];
async function crit(id, name, fn) {
  const fails = [];
  const t = (cond, msg) => { if (!cond) fails.push(msg); };
  try { await fn(t); } catch (e) { fails.push('threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
  results.push(!fails.length);
  console.log(`${fails.length ? 'FAIL' : 'PASS'} ${id} ${name}`);
  for (const f of fails.slice(0, 8)) console.log('     - ' + f);
}

await crit('C1', '50 concurrent sends: cap of 3 is exact, same id sent once, two workers on one state directory agree', async t => {
  {
    const prov = makeProvider({ latency: 5 }), d = createDispatcher({ stateDir: tmpState(), provider: prov, users: [mkUser('cu')], policy: pol(3) });
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => settle(d.dispatch(msg('a' + i, 'cu')))));
    t(rs.every(r => r.ok), 'no dispatch may throw: ' + rs.find(r => !r.ok)?.e);
    const sent = rs.filter(r => r.ok && r.v.status === 'sent'), blk = rs.filter(r => r.ok && r.v.status === 'blocked');
    t(sent.length === 3 && blk.length === 47, `expected 3 sent and 47 blocked, got ${sent.length} and ${blk.length}`);
    t(prov.deliveries.length === 3, `vendor must receive exactly 3 deliveries, got ${prov.deliveries.length}`);
    t(blk.every(r => codes(r.v).includes('rolling_24h_cap') && /\b3\b/.test(r.v.reasons.find(x => x.code === 'rolling_24h_cap').detail)), 'blocked results carry rolling_24h_cap with the limit in the detail');
    const u = await d.usage('cu', AT);
    t(u.rolling24h === 3 && u.rolling7d === 3, `usage must be 3 and 3, got ${JSON.stringify(u)}`);
  }
  {
    const prov = makeProvider({ latency: 5 }), d = createDispatcher({ stateDir: tmpState(), provider: prov, users: [mkUser('cu')], policy: pol(3) });
    const rs = await Promise.all(Array.from({ length: 50 }, () => settle(d.dispatch(msg('same', 'cu')))));
    t(rs.every(r => r.ok && ['sent', 'already_sent'].includes(r.v.status)), 'duplicates of one id resolve to sent or already_sent');
    t(nDel(prov, 'same') === 1, `one id submitted 50 times must be delivered once, got ${nDel(prov, 'same')}`);
    t(new Set(rs.map(r => r.v?.providerId)).size === 1, 'all duplicates report the same providerId');
    t((await d.usage('cu', AT)).rolling24h === 1, 'one message counts once however many times it is submitted');
  }
  {
    const dirS = tmpState(), prov = makeProvider({ latency: 5 });
    const A = createDispatcher({ stateDir: dirS, provider: prov, users: [mkUser('cu')], policy: pol(3) });
    const B = createDispatcher({ stateDir: dirS, provider: prov, users: [mkUser('cu')], policy: pol(3) });
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => settle((i % 2 ? A : B).dispatch(msg('w' + i, 'cu')))));
    t(rs.every(r => r.ok), 'no worker call may throw: ' + rs.find(r => !r.ok)?.e);
    t(prov.deliveries.length === 3, `two workers sharing one state directory must still deliver exactly 3, got ${prov.deliveries.length}`);
    t((await A.usage('cu', AT)).rolling24h === 3, 'usage read through worker A is 3');
    const dup = await Promise.all(Array.from({ length: 20 }, (_, i) => settle((i % 2 ? A : B).dispatch(msg('twice', 'cu', 'push', '2026-06-11T12:00:00Z')))));
    t(nDel(prov, 'twice') <= 1, 'the same id on two workers is delivered at most once');
  }
});

await crit('C2', 'crash between send and record: retry neither double-sends nor double-counts, and the lost send still holds its budget', async t => {
  {
    const dirS = tmpState(), prov = makeProvider(); prov.crashAfter.add('x1');
    const mk = () => createDispatcher({ stateDir: dirS, provider: prov, users: [mkUser('cr')], policy: pol(1) });
    const d1 = mk();
    const first = await settle(d1.dispatch(msg('x1', 'cr')));
    t(!first.ok || first.v.status !== 'sent', 'a dispatch whose vendor call failed must not report sent');
    t(nDel(prov, 'x1') === 1, 'the vendor did deliver x1 before the crash');
    const d2 = mk();
    const u = await d2.usage('cr', AT);
    t(u.rolling24h === 1, `after restart the lost send must still count once, got ${u.rolling24h}`);
    const y = await settle(d2.dispatch(msg('y1', 'cr', 'push', '2026-06-10T12:01:00Z')));
    t(y.ok && y.v.status === 'blocked' && codes(y.v).includes('rolling_24h_cap'), 'a different message must be blocked by the cap, because x1 holds the only slot, got ' + JSON.stringify(y.ok ? y.v : String(y.e)));
    const retry = await settle(d2.dispatch(msg('x1', 'cr')));
    t(retry.ok && ['sent', 'already_sent'].includes(retry.v.status), 'retrying x1 must not be blocked by its own slot, got ' + JSON.stringify(retry.ok ? retry.v : String(retry.e)));
    t(nDel(prov, 'x1') === 1, `retry must not deliver again, deliveries of x1: ${nDel(prov, 'x1')}`);
    const again = await settle(mk().dispatch(msg('x1', 'cr')));
    t(again.ok && nDel(prov, 'x1') === 1, 'a third retry from a third process is still a single delivery');
    t((await mk().usage('cr', AT)).rolling24h === 1, 'usage stays 1 after retries');
    const keys = prov.calls.filter(c => c.id === 'x1').map(c => c.key);
    t(keys.length >= 2 && keys.every(k => typeof k === 'string' && k.length > 0 && k === keys[0]), 'every attempt for x1 must carry the same non-empty idempotency key, got ' + JSON.stringify(keys));
  }
  {
    const dirS = tmpState(), prov = makeProvider(); prov.failBefore.add('w1');
    const mk = () => createDispatcher({ stateDir: dirS, provider: prov, users: [mkUser('cr2')], policy: pol(2) });
    const first = await settle(mk().dispatch(msg('w1', 'cr2')));
    t(!first.ok || first.v.status !== 'sent', 'failed attempt is not reported as sent');
    t(nDel(prov, 'w1') === 0, 'nothing was delivered by the failed attempt');
    const r = await settle(mk().dispatch(msg('w1', 'cr2')));
    t(r.ok && nDel(prov, 'w1') === 1, 'the retry delivers exactly once');
    const w2 = await settle(mk().dispatch(msg('w2', 'cr2', 'push', '2026-06-10T12:01:00Z')));
    t(w2.ok && w2.v.status === 'sent', 'with cap 2 and one counted message, a second message goes out');
    const w3 = await settle(mk().dispatch(msg('w3', 'cr2', 'push', '2026-06-10T12:02:00Z')));
    t(w3.ok && w3.v.status === 'blocked', 'the third is blocked: w1 was counted once, not twice');
    t((await mk().usage('cr2', '2026-06-10T12:05:00Z')).rolling24h === 2, 'usage is 2');
  }
  {
    const prov = makeProvider(), d = createDispatcher({ stateDir: tmpState(), provider: prov, users: [mkUser('k')], policy: pol(10) });
    await d.dispatch(msg('k1', 'k')); await d.dispatch(msg('k2', 'k'));
    const ks = prov.calls.map(c => c.key);
    t(ks.every(Boolean) && new Set(ks).size === 2, 'different messages must use different idempotency keys (a shared key would make the vendor drop the second)');
  }
});

await crit('C3', 'STOP and START: keyword rules, sms only, survives restart, and no sms call starts after STOP is acknowledged', async t => {
  const dirS = tmpState(), prov = makeProvider();
  const mk = () => createDispatcher({ stateDir: dirS, provider: prov, users: [mkUser('s1')], policy: pol(1000) });
  const d = mk();
  const inb = (body, channel = 'sms') => d.handleInbound({ userId: 's1', channel, body, at: AT });
  const probe = async (body, want) => { const r = await settle(Promise.resolve(inb(body))); t(r.ok && r.v?.action === want, `inbound ${JSON.stringify(body)} should be action ${want}, got ${r.ok ? r.v?.action : r.e}`); };
  for (const b of ['please do not stop sending', 'stopping by later', 'Stop by at 5?', 'endless', 'thanks', '', 'start the day']) await probe(b, 'none');
  t((await d.dispatch(msg('pre', 's1', 'sms'))).status === 'sent', 'sms is delivered before any STOP');
  const em = await inb('STOP', 'email'); t(em.action === 'none', 'STOP on a non-sms channel does nothing');
  t((await d.dispatch(msg('pre2', 's1', 'sms'))).status === 'sent', 'a STOP typed on email does not stop sms');
  for (const b of ['STOP', 'stop', '  Stop. ', 'STOPALL', 'Unsubscribe', 'QUIT', 'end', 'Cancel!']) { await probe(b, 'stop'); await probe('START', 'start'); }
  await probe('STOP', 'stop');
  let r = await d.dispatch(msg('post', 's1', 'sms'));
  t(r.status === 'blocked' && eq(codes(r), ['sms_stopped']), 'after STOP an sms is blocked with exactly [sms_stopped], got ' + JSON.stringify(r));
  t((await d.dispatch(msg('post-push', 's1', 'push'))).status === 'sent', 'push to the same person is still allowed after sms STOP');
  r = await mk().dispatch(msg('post2', 's1', 'sms'));
  t(r.status === 'blocked' && codes(r).includes('sms_stopped'), 'STOP survives a restart');
  t(nDel(prov, 'post') === 0 && nDel(prov, 'post2') === 0, 'nothing was delivered after STOP');
  await probe('unstop', 'start');
  t((await d.dispatch(msg('after-start', 's1', 'sms'))).status === 'sent', 'START re-enables sms');
  // race: 40 concurrent sms while STOP arrives
  const dirR = tmpState(), prov2 = makeProvider({ latency: 3 });
  const dr = createDispatcher({ stateDir: dirR, provider: prov2, users: [mkUser('race')], policy: pol(1000) });
  const run = Promise.all(Array.from({ length: 40 }, (_, i) => settle(dr.dispatch(msg('r' + i, 'race', 'sms', `2026-06-10T12:${String(i).padStart(2, '0')}:00Z`)))));
  await sleep(8);
  await dr.handleInbound({ userId: 'race', channel: 'sms', body: 'STOP', at: AT });
  const stopSeq = prov2.seqNow();
  const rs = await run;
  const late = prov2.calls.filter(c => c.userId === 'race' && c.callSeq > stopSeq);
  t(late.length === 0, `${late.length} vendor calls started after STOP had been acknowledged`);
  t(rs.every(x => x.ok), 'no dispatch throws during the race');
  t((await dr.dispatch(msg('late', 'race', 'sms', '2026-06-10T13:30:00Z'))).status === 'blocked', 'a fresh sms after the race is blocked');
});

await crit('C4', 'quiet hours in the recipient zone across DST, blocked messages cost nothing, ordered reasons, rolling usage boundaries', async t => {
  const la = id => mkUser(id, { tz: 'America/Los_Angeles', quiet: { start: '21:00', end: '08:00' } });
  const cases = [
    ['2026-03-08T14:59:00Z', false, '07:59'], ['2026-03-08T15:00:00Z', true, ''],
    ['2026-11-01T15:00:00Z', false, '07:00'], ['2026-11-01T16:00:00Z', true, ''], ['2026-11-01T14:59:00Z', false, '06:59'],
  ];
  for (const [at, ok, hhmm] of cases) {
    const prov = makeProvider(), d = createDispatcher({ stateDir: tmpState(), provider: prov, users: [la('q')], policy: pol(3) });
    const r = await d.dispatch(msg('q1', 'q', 'push', at));
    if (ok) t(r.status === 'sent', `${at} is outside quiet hours in Los Angeles, got ${r.status}`);
    else {
      t(r.status === 'blocked' && eq(codes(r), ['quiet_hours']), `${at} is quiet in Los Angeles, got ${JSON.stringify(codes(r))}`);
      t(r.reasons?.[0]?.detail?.includes(hhmm) && r.reasons[0].detail.includes('America/Los_Angeles'), `detail for ${at} must name America/Los_Angeles and ${hhmm}, got ${r.reasons?.[0]?.detail}`);
      t((await d.usage('q', at)).rolling24h === 0 && prov.calls.length === 0, 'a blocked message neither counts nor reaches the vendor');
    }
  }
  {
    const prov = makeProvider(), d = createDispatcher({ stateDir: tmpState(), provider: prov, users: [la('qc')], policy: pol(3) });
    t((await d.dispatch(msg('c1', 'qc', 'push', '2026-03-08T14:00:00Z', { priority: 'critical' }))).status === 'sent', 'critical bypasses quiet hours');
  }
  {
    const prov = makeProvider(), u = mkUser('mu', { consent: { push: true, sms: false }, quiet: { start: '22:00', end: '07:00' } });
    const d = createDispatcher({ stateDir: tmpState(), provider: prov, users: [u], policy: pol(1) });
    t((await d.dispatch(msg('m1', 'mu', 'push', AT))).status === 'sent', 'first push goes out');
    const r = await d.dispatch(msg('m2', 'mu', 'sms', '2026-06-10T23:00:00Z'));
    t(eq(codes(r), ['no_consent', 'quiet_hours', 'rolling_24h_cap']), 'reasons in fixed order, got ' + JSON.stringify(codes(r)));
    t((r.reasons || []).every(x => typeof x.detail === 'string' && x.detail.length > 8), 'every reason has a detail');
    const T = Date.parse(AT);
    const iso = ms => new Date(ms).toISOString();
    let us = await d.usage('mu', iso(T + 86400000));
    t(us.rolling24h === 0 && us.rolling7d === 1, `exactly 24h later the message left the 24h window but is in the 7d window, got ${JSON.stringify(us)}`);
    us = await d.usage('mu', iso(T + 86400000 - 1000));
    t(us.rolling24h === 1, 'one second before 24h it still counts');
    us = await d.usage('mu', iso(T + 7 * 86400000));
    t(us.rolling7d === 0, 'exactly 7 days later it has left the 7d window');
    us = await d.usage('mu', iso(T + 7 * 86400000 - 1000));
    t(us.rolling7d === 1, 'one second before 7 days it still counts');
  }
});

await crit('C5', 'concurrency across recipients is not serialized: 50 recipients, 40 ms vendor latency, all delivered once', async t => {
  const users = Array.from({ length: 50 }, (_, i) => mkUser('p' + i));
  const prov = makeProvider({ latency: 40 }), d = createDispatcher({ stateDir: tmpState(), provider: prov, users, policy: pol(3) });
  const t0 = Date.now();
  const rs = await Promise.all(users.map(u => settle(d.dispatch(msg('b-' + u.id, u.id)))));
  const ms = Date.now() - t0;
  t(rs.every(r => r.ok && r.v.status === 'sent'), 'all 50 are sent: ' + JSON.stringify(rs.find(r => !r.ok || r.v.status !== 'sent')));
  t(prov.deliveries.length === 50 && new Set(prov.deliveries.map(x => x.id)).size === 50, 'exactly 50 deliveries, one per message');
  t(ms < 1000, `50 recipients at 40 ms each took ${ms} ms; one global lock would take about 2000 ms, the limit is 1000 ms`);
  const us = await Promise.all(users.map(u => d.usage(u.id, AT)));
  t(us.every(x => x.rolling24h === 1), 'each recipient has usage 1');
});

const failed = results.filter(x => !x).length;
console.log(failed ? `\n${failed} of ${results.length} criteria failed` : `\nall ${results.length} criteria passed`);
process.exit(failed ? 1 : 0);
