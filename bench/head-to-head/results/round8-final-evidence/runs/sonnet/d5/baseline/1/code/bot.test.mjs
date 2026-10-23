import test from 'node:test';
import assert from 'node:assert/strict';
import { planSends } from './bot.mjs';

// 2026-03-10T15:00:00Z = 10:00 in Chicago (CDT, UTC-5), 16:00 in Berlin... (CET, UTC+1)
const NOW = new Date('2026-03-10T15:00:00Z');
const user = (o = {}) => ({ timeZone: 'America/Chicago', promoOptIn: true, quietHours: null, ...o });
const c = (id, category, priority, dedupeKey = id) => ({ id, category, priority, dedupeKey });
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const H = 3600e3;
const plan = (o) => planSends({ user: user(), candidates: [], history: [], now: NOW, ...o });
const rules = (r) => Object.fromEntries(r.dropped.map((d) => [d.id, d.rule]));

test('orders by priority, critical first, ties stable', () => {
  const r = plan({ candidates: [c('a', 'reminder', 1), c('b', 'promo', 5), c('x', 'critical', 0), c('d', 'reminder', 5)] });
  assert.deepEqual(r.send, ['x', 'b', 'd', 'a']);
  assert.deepEqual(r.dropped, []);
});

test('promo without opt-in is held; reminder is not', () => {
  const r = plan({ user: user({ promoOptIn: false }), candidates: [c('p', 'promo', 9), c('r', 'reminder', 1)] });
  assert.deepEqual(r.send, ['r']);
  assert.deepEqual(rules(r), { p: 'promo-no-opt-in' });
});

test('quiet hours use local time, wrap midnight, start inclusive end exclusive', () => {
  const q = { start: '22:00', end: '10:30' }; // local now = 10:00 -> quiet
  let r = plan({ user: user({ quietHours: q }), candidates: [c('r', 'reminder', 1), c('k', 'critical', 1)] });
  assert.deepEqual(r.send, ['k']);
  assert.deepEqual(rules(r), { r: 'quiet-hours' });
  // same instant, Berlin local 16:00 -> not quiet
  r = plan({ user: user({ timeZone: 'Europe/Berlin', quietHours: q }), candidates: [c('r', 'reminder', 1)] });
  assert.deepEqual(r.send, ['r']);
  // end exclusive: window 08:00-10:00, local 10:00 -> allowed; start inclusive: 10:00-11:00 -> held
  assert.deepEqual(plan({ user: user({ quietHours: { start: '08:00', end: '10:00' } }), candidates: [c('r', 'reminder', 1)] }).send, ['r']);
  assert.deepEqual(plan({ user: user({ quietHours: { start: '10:00', end: '11:00' } }), candidates: [c('r', 'reminder', 1)] }).send, []);
});

test('invalid zone / window fail closed for non-critical only', () => {
  let r = plan({ user: user({ timeZone: 'Nope/Zone', quietHours: { start: '22:00', end: '07:00' } }), candidates: [c('r', 'reminder', 1), c('k', 'critical', 1)] });
  assert.deepEqual(r.send, ['k']);
  assert.deepEqual(rules(r), { r: 'invalid-time-zone' });
  r = plan({ user: user({ quietHours: { start: '25:00', end: '07:00' } }), candidates: [c('r', 'reminder', 1)] });
  assert.deepEqual(rules(r), { r: 'invalid-quiet-hours' });
});

test('24h cap counts history, not critical, boundary exact 24h is outside', () => {
  const history = [
    { sentAt: ago(24 * H), category: 'promo', dedupeKey: 'old' }, // outside
    { sentAt: ago(23 * H), category: 'reminder', dedupeKey: 'h1' },
    { sentAt: ago(1 * H), category: 'critical', dedupeKey: 'h2' }, // not counted
    { sentAt: ago(2 * H), category: 'promo', dedupeKey: 'h3' },
  ];
  const r = plan({ history, candidates: [c('a', 'reminder', 3), c('b', 'reminder', 2), c('k', 'critical', 0), c('d', 'promo', 1)] });
  assert.deepEqual(r.send, ['k', 'a']);
  assert.deepEqual(rules(r), { b: 'cap-24h', d: 'cap-24h' });
});

test('cap picks highest priority within a batch', () => {
  const r = plan({ candidates: [1, 2, 3, 4, 5].map((n) => c('m' + n, 'reminder', n)) });
  assert.deepEqual(r.send, ['m5', 'm4', 'm3']);
  assert.deepEqual(rules(r), { m2: 'cap-24h', m1: 'cap-24h' });
});

test('dedupe 7 days from history, applies to critical too; 7d exactly is allowed', () => {
  const history = [
    { sentAt: ago(6 * 24 * H), category: 'reminder', dedupeKey: 'k1' },
    { sentAt: ago(7 * 24 * H), category: 'reminder', dedupeKey: 'k2' },
  ];
  const r = plan({ history, candidates: [c('a', 'reminder', 1, 'k1'), c('b', 'reminder', 1, 'k2'), c('c', 'critical', 1, 'k1')] });
  assert.deepEqual(r.send, ['b']);
  assert.deepEqual(rules(r), { a: 'dedupe-7d', c: 'dedupe-7d' });
});

test('dedupe inside batch keeps the best; a held twin does not block it', () => {
  let r = plan({ candidates: [c('lo', 'reminder', 1, 'k'), c('hi', 'reminder', 9, 'k')] });
  assert.deepEqual(r.send, ['hi']);
  assert.deepEqual(rules(r), { lo: 'dedupe-in-batch' });
  r = plan({ user: user({ promoOptIn: false }), candidates: [c('p', 'promo', 9, 'k'), c('r', 'reminder', 1, 'k')] });
  assert.deepEqual(r.send, ['r']);
});

test('unknown category and bad history are handled', () => {
  const r = plan({ history: [{ sentAt: 'garbage', category: 'promo', dedupeKey: 'g' }], candidates: [c('z', 'weird', 1), c('g', 'reminder', 1, 'g')] });
  assert.deepEqual(rules(r), { z: 'invalid-category', g: 'dedupe-7d' });
});

test('pure: no mutation, deterministic, every candidate accounted for once', () => {
  const args = {
    user: user({ quietHours: { start: '22:00', end: '07:00' } }),
    candidates: [c('a', 'promo', 1), c('b', 'reminder', 2), c('c', 'critical', 0)],
    history: [{ sentAt: ago(H), category: 'promo', dedupeKey: 'x' }],
    now: NOW,
  };
  const before = structuredClone({ ...args, now: NOW.getTime() });
  const r1 = planSends(args);
  const r2 = planSends(args);
  assert.deepEqual(r1, r2);
  assert.deepEqual(structuredClone({ ...args, now: NOW.getTime() }), before);
  assert.equal(r1.send.length + r1.dropped.length, 3);
});
