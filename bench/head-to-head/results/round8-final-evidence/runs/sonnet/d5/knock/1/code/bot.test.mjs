import test from 'node:test';
import assert from 'node:assert/strict';
import { planSends } from './bot.mjs';

// 2026-01-15 15:00 UTC = 09:00 in America/Chicago (CST, UTC-6)
const now = new Date('2026-01-15T15:00:00Z');
const user = { timeZone: 'America/Chicago', promoOptIn: true, quietHours: null };
const c = (id, category, priority, dedupeKey = id) => ({ id, category, priority, dedupeKey });
const h = (sentAt, category = 'reminder', dedupeKey = 'x') => ({ sentAt, category, dedupeKey });
const run = (o) => planSends({ user, candidates: [], history: [], now, ...o });
const rules = (r) => Object.fromEntries(r.dropped.map((d) => [d.id, d.rule]));

test('orders best first', () => {
  const r = run({ candidates: [c('a', 'reminder', 1), c('b', 'promo', 5), c('c', 'reminder', 3)] });
  assert.deepEqual(r.send, ['b', 'c', 'a']);
  assert.deepEqual(r.dropped, []);
});

test('promo without opt-in dropped, critical and reminder unaffected', () => {
  const r = run({ user: { ...user, promoOptIn: false }, candidates: [c('p', 'promo', 9), c('r', 'reminder', 1), c('k', 'critical', 1)] });
  assert.deepEqual(r.send, ['r', 'k']);
  assert.deepEqual(rules(r), { p: 'promo-no-opt-in' });
});

test('quiet hours wrapping midnight use local time; critical bypasses', () => {
  const q = { start: '22:00', end: '09:30' };
  const r = run({ user: { ...user, quietHours: q }, candidates: [c('r', 'reminder', 1), c('p', 'promo', 2), c('k', 'critical', 0)] });
  assert.deepEqual(r.send, ['k']);
  assert.deepEqual(rules(r), { r: 'quiet-hours', p: 'quiet-hours' });
  // 09:30 local is outside (end exclusive)
  const r2 = planSends({ user: { ...user, quietHours: q }, candidates: [c('r', 'reminder', 1)], history: [], now: new Date('2026-01-15T15:30:00Z') });
  assert.deepEqual(r2.send, ['r']);
  // same-day window, UTC instant would be outside but local is inside
  const r3 = run({ user: { ...user, quietHours: { start: '08:00', end: '10:00' } }, candidates: [c('r', 'reminder', 1)] });
  assert.deepEqual(rules(r3), { r: 'quiet-hours' });
});

test('DST: local time follows the zone offset', () => {
  // 2026-07-15 14:00 UTC = 09:00 CDT
  const r = planSends({ user: { ...user, quietHours: { start: '08:30', end: '09:30' } }, candidates: [c('r', 'reminder', 1)], history: [], now: new Date('2026-07-15T14:00:00Z') });
  assert.deepEqual(rules(r), { r: 'quiet-hours' });
});

test('rolling 24h cap counts history, ignores critical and older entries', () => {
  const history = [
    h('2026-01-15T14:00:00Z', 'promo', 'a'),
    h('2026-01-14T15:00:01Z', 'reminder', 'b'),
    h('2026-01-14T15:00:00Z', 'reminder', 'old'), // exactly 24h ago: outside
    h('2026-01-15T14:30:00Z', 'critical', 'k'),
  ];
  const r = run({ history, candidates: [c('x', 'reminder', 1), c('y', 'reminder', 3), c('z', 'promo', 2), c('k2', 'critical', 0)] });
  assert.deepEqual(r.send, ['y', 'k2']);
  assert.deepEqual(rules(r), { x: 'rolling-24h-cap', z: 'rolling-24h-cap' });
});

test('cap of 3 with empty history', () => {
  const r = run({ candidates: [1, 2, 3, 4, 5].map((n) => c('m' + n, 'reminder', n)) });
  assert.deepEqual(r.send, ['m5', 'm4', 'm3']);
});

test('7-day dedupe, any history category, boundary exclusive', () => {
  const history = [h('2026-01-08T15:00:01Z', 'critical', 'k'), h('2026-01-08T15:00:00Z', 'promo', 'edge')];
  const r = run({ history, candidates: [c('a', 'reminder', 1, 'k'), c('b', 'reminder', 1, 'edge')] });
  assert.deepEqual(r.send, ['b']);
  assert.deepEqual(rules(r), { a: 'dedupe-7d' });
});

test('same dedupeKey in one batch keeps only the best; loser does not use a slot', () => {
  const r = run({ candidates: [c('lo', 'reminder', 1, 'k'), c('hi', 'reminder', 5, 'k'), c('o', 'reminder', 2)] });
  assert.deepEqual(r.send, ['hi', 'o']);
  assert.deepEqual(rules(r), { lo: 'dedupe-in-batch' });
});

test('unknown category dropped; inputs not mutated', () => {
  const input = { user: { ...user, quietHours: { start: '01:00', end: '02:00' } }, candidates: [c('a', 'reminder', 1), c('u', 'sms', 1)], history: [h('2026-01-15T14:00:00Z')], now };
  const snap = structuredClone(input);
  const r = planSends(input);
  assert.deepEqual(rules(r), { u: 'unknown-category' });
  assert.deepEqual(input.user, snap.user);
  assert.deepEqual(input.candidates, snap.candidates);
  assert.deepEqual(input.history, snap.history);
  assert.equal(input.now.getTime(), snap.now.getTime());
});

test('every candidate is in exactly one of send/dropped', () => {
  const candidates = [c('a', 'promo', 1), c('b', 'reminder', 2, 'k'), c('d', 'reminder', 1, 'k'), c('e', 'critical', 0), c('f', 'reminder', 3), c('g', 'reminder', 4), c('i', 'reminder', 5)];
  const r = run({ candidates });
  const all = [...r.send, ...r.dropped.map((d) => d.id)].sort();
  assert.deepEqual(all, candidates.map((x) => x.id).sort());
});
