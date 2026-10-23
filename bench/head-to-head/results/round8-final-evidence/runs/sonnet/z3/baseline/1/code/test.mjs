import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
process.env.STATE_DIR = dir;
const { deliver, recordDismissal } = await import('./bot.mjs');
const calls = { push: 0, inApp: 0 };
const transport = { push: async () => { calls.push++; return true; }, inApp: async () => { calls.inApp++; } };
const consent = { get: async () => ({ push: true }) };
const mk = (o = {}) => ({ id: 'u' + Math.random(), timezone: 'America/New_York', categories: { briefing: true, tips: true }, snoozedUntil: null, platform: 'ios', notificationsPermitted: true, ...o });
const d = (user, cand, now, extra = {}) => deliver({ user, candidate: cand, now, transport, consentStore: extra.cs ?? consent });
const B = (id = 'b1') => ({ id, type: 'briefing' });
const t8 = '2026-10-23T12:30:00Z'; // 08:30 NY (EDT)
let r;
r = await d(mk(), B(), t8); assert.deepEqual([r.push, r.inApp, r.reason, r.resumeAt], [true, true, null, null]);
let u = mk(); await d(u, B(), t8); r = await d(u, B(), t8); assert.equal(r.push, true); assert.equal(calls.push, 2); // replay not resent
r = await d(u, B('b2'), '2026-10-23T14:00:00Z'); assert.equal(r.push, false); assert.match(r.resumeAt, /^2026-10-24T12:00/);
r = await d(mk(), B(), '2026-10-23T09:00:00Z'); assert.equal(r.resumeAt, '2026-10-23T12:00:00.000Z'); assert.equal(r.inApp, false);
r = await d(mk(), B(), '2026-10-23T20:00:00Z'); assert.equal(r.resumeAt, '2026-10-24T12:00:00.000Z');
r = await d(mk({ categories: { briefing: false } }), B(), t8); assert.deepEqual([r.push, r.inApp, r.resumeAt], [false, false, null]);
r = await d(mk({ categories: undefined }), B(), t8); assert.equal(r.push, false);
r = await d(mk({ snoozedUntil: '2026-10-23T22:00:00Z' }), B(), t8); assert.equal(r.resumeAt, '2026-10-24T12:00:00.000Z');
r = await d(mk({ snoozedUntil: '2026-10-24T13:00:00Z' }), B(), t8); assert.equal(r.resumeAt, '2026-10-24T13:00:00.000Z');
r = await d(mk({ snoozedUntil: '2026-10-23T10:00:00Z' }), B(), t8); assert.equal(r.push, true);
r = await d(mk(), B(), t8, { cs: { get: async () => { throw new Error('down'); } } }); assert.deepEqual([r.push, r.inApp], [false, true]); assert.ok(r.reason);
r = await d(mk(), B(), t8, { cs: { get: async () => ({ push: false }) } }); assert.deepEqual([r.push, r.inApp], [false, true]);
r = await d(mk({ notificationsPermitted: false }), B(), t8); assert.deepEqual([r.push, r.inApp], [false, true]);
r = await d(mk({ notificationsPermitted: undefined }), B(), t8); assert.equal(r.push, true);
const noTok = { push: async () => false, inApp: async () => {} };
r = await deliver({ user: mk(), candidate: B(), now: t8, transport: noTok, consentStore: consent }); assert.deepEqual([r.push, r.inApp], [false, true]); assert.ok(r.reason);
r = await d(mk({ timezone: 'Nope/Zone' }), B(), t8); assert.equal(r.push, false); assert.equal(r.inApp, true);
// DST: Tokyo (no DST) and Berlin fall-back day
r = await d(mk({ timezone: 'Europe/Berlin' }), B(), '2026-10-25T05:00:00Z'); assert.equal(r.resumeAt, '2026-10-25T07:00:00.000Z'); // 06:00 CET -> 08:00 CET
// dismissals
u = mk({ categories: { tips: true } });
for (let i = 0; i < 3; i++) await recordDismissal(u.id, 'tips', new Date(Date.parse(t8) - i * 3600e3));
r = await d(u, { id: 't1', type: 'tips' }, t8); assert.equal(r.inApp, false); assert.ok(r.resumeAt);
r = await d(u, { id: 't2', type: 'tips' }, '2026-11-01T16:00:00Z'); assert.equal(r.push, true);
// concurrency: many processes, same user, same + different briefing ids
const cu = mk({ id: 'shared' });
const sdir = path.join(os.tmpdir(), 'w-' + process.pid);
fs.writeFileSync(path.join(os.tmpdir(), 'worker.mjs'), `
import { deliver, recordDismissal } from ${JSON.stringify(path.resolve('bot.mjs'))};
import fs from 'node:fs';
process.on('message', async (m) => {
  const log = ${JSON.stringify(sdir)};
  const tr = { push: async () => { fs.appendFileSync(log + '.push', 'x'); return true; }, inApp: async () => { fs.appendFileSync(log + '.app', 'x'); } };
  const r = await deliver({ user: m.user, candidate: m.c, now: m.now, transport: tr, consentStore: { get: async () => ({}) } });
  await recordDismissal(m.user.id, 'tips', m.now);
  process.send(r); process.exit(0);
});`);
const res = await Promise.all(Array.from({ length: 16 }, (_, i) => new Promise((ok) => {
  const c = fork(path.join(os.tmpdir(), 'worker.mjs'), { env: { ...process.env, STATE_DIR: dir } });
  c.on('message', ok); c.send({ user: cu, c: B(i % 2 ? 'same' : 'other' + i), now: t8 });
})));
const pushes = fs.readFileSync(sdir + '.push', 'utf8').length;
console.log('concurrent pushes', pushes, res.filter((x) => x.push).length);
assert.equal(pushes, 1);
const st = JSON.parse(fs.readFileSync(fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f)).find(f => fs.readFileSync(f,'utf8').includes('"tips":[16') || JSON.parse(fs.readFileSync(f,'utf8')).dismissals?.tips?.length === 1) ?? '/dev/null', 'utf8') || '{}');
console.log('all ok');
