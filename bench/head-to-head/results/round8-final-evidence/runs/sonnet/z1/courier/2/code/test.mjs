import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const self = fileURLToPath(import.meta.url);
if (process.argv[2] === 'worker') {
  const { decide } = await import('./bot.mjs');
  const r = await decide({ user: JSON.parse(process.argv[4]), candidate: { id: process.argv[3], type: 'checkin' }, now: new Date('2026-10-23T10:00:00Z'), flags: { proactiveEnabled: true } });
  console.log(r.send ? 'SENT' : 'NO'); process.exit(0);
}
process.env.STATE_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')), 'nested');
const { decide, recordDismissal, optOut } = await import('./bot.mjs');
const U = (o = {}) => ({ id: 'u1', timezone: 'Europe/Istanbul', consents: { marketing: true }, createdAt: '2026-01-01T00:00:00Z', ...o });
const C = (id, type = 'checkin') => ({ id, type });
const F = { proactiveEnabled: true };
const at = (s) => new Date(s);
const ok = async (n, p) => { assert.equal((await p).send, true, n); };
const bad = async (n, p) => { const r = await p; assert.equal(r.send, false, n); assert.ok(r.reason, n); };
await bad('flag off', decide({ user: U({ id: 'a' }), candidate: C('1'), now: at('2026-10-23T08:00:00Z'), flags: { proactiveEnabled: false } }));
await bad('no consent', decide({ user: U({ id: 'b', consents: {} }), candidate: C('1'), now: at('2026-10-23T08:00:00Z'), flags: F }));
await bad('missing consents', decide({ user: U({ id: 'b2', consents: undefined }), candidate: C('1'), now: at('2026-10-23T08:00:00Z'), flags: F }));
await bad('night local (01:00 Istanbul)', decide({ user: U({ id: 'c' }), candidate: C('1'), now: at('2026-10-22T22:00:00Z'), flags: F }));
await bad('UTC placeholder only', decide({ user: U({ id: 'd', timezone: 'UTC' }), candidate: C('1'), now: at('2026-10-23T10:00:00Z'), flags: F }));
await bad('no zone', decide({ user: U({ id: 'd2', timezone: undefined }), candidate: C('1'), now: at('2026-10-23T10:00:00Z'), flags: F }));
await ok('device zone wins (Tokyo 19:00)', decide({ user: U({ id: 'e', timezone: 'UTC', deviceTimezone: 'Asia/Tokyo' }), candidate: C('1'), now: at('2026-10-23T10:00:00Z'), flags: F }));
await bad('device zone night (Tokyo 06:00 though saved Istanbul 00:00..)', decide({ user: U({ id: 'e2', deviceTimezone: 'Asia/Tokyo' }), candidate: C('1'), now: at('2026-10-22T21:00:00Z'), flags: F }));
// normal + once per day + idempotent
await ok('first', decide({ user: U(), candidate: C('1'), now: at('2026-10-23T07:00:00Z'), flags: F }));
await bad('same id again', decide({ user: U(), candidate: C('1'), now: at('2026-10-23T07:30:00Z'), flags: F }));
await bad('second checkin same day', decide({ user: U(), candidate: C('2'), now: at('2026-10-23T14:00:00Z'), flags: F }));
await bad('tip too soon', decide({ user: U(), candidate: C('t1', 'tip'), now: at('2026-10-23T08:00:00Z'), flags: F }));
await ok('tip later', decide({ user: U(), candidate: C('t1', 'tip'), now: at('2026-10-23T12:00:00Z'), flags: F }));
await bad('daily cap', decide({ user: U(), candidate: C('t2', 'other'), now: at('2026-10-23T16:30:00Z'), flags: F }));
await ok('next day', decide({ user: U(), candidate: C('3'), now: at('2026-10-24T07:00:00Z'), flags: F }));
// dismissal back-off
await recordDismissal('u1', 'checkin', at('2026-10-24T08:00:00Z'));
await bad('after dismissal d+1', decide({ user: U(), candidate: C('4'), now: at('2026-10-25T08:00:00Z'), flags: F }));
await ok('after dismissal d+2', decide({ user: U(), candidate: C('5'), now: at('2026-10-26T08:01:00Z'), flags: F }));
await recordDismissal('u1', 'checkin', at('2026-10-26T09:00:00Z'));
await bad('second dismissal = 4 days', decide({ user: U(), candidate: C('6'), now: at('2026-10-29T09:00:00Z'), flags: F }));
await ok('after 4 days', decide({ user: U(), candidate: C('7'), now: at('2026-10-30T09:30:00Z'), flags: F }));
// opt-out
await optOut('u1', 'checkin');
await bad('opted out', decide({ user: U(), candidate: C('8'), now: at('2026-12-30T09:00:00Z'), flags: F }));
await ok('other type still ok', decide({ user: U(), candidate: C('t9', 'tip'), now: at('2026-12-30T09:00:00Z'), flags: F }));
// restart persistence
const r = await new Promise((res) => { const p = spawn('node', ['-e', `import('./bot.mjs').then(async m=>{const r=await m.decide({user:{id:'u1',timezone:'Europe/Istanbul',consents:{marketing:true}},candidate:{id:'z',type:'checkin'},now:new Date('2027-03-01T09:00:00Z'),flags:{proactiveEnabled:true}});console.log(r.send)})`], { env: process.env }); let o = ''; p.stdout.on('data', (d) => (o += d)); p.on('close', () => res(o.trim())); });
assert.equal(r, 'false', 'opt-out survives restart');
// concurrency: 12 processes, distinct candidate ids, same user
const outs = await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((res) => {
  const p = spawn('node', [self, 'worker', 'c' + i, JSON.stringify(U({ id: 'conc' }))], { env: process.env }); let o = ''; p.stdout.on('data', (d) => (o += d)); p.on('close', () => res(o.trim()));
})));
assert.equal(outs.filter((o) => o === 'SENT').length, 1, 'exactly one send: ' + outs);
console.log('all ok');
