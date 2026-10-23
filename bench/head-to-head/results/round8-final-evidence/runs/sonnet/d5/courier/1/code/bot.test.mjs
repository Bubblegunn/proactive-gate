import test from 'node:test';
import assert from 'node:assert/strict';
import { planSends } from './bot.mjs';

const user = { timeZone: 'America/Chicago', promoOptIn: true, quietHours: { start: '22:00', end: '07:00' } };
// 2026-07-01T18:00Z = 13:00 in Chicago (CDT), outside quiet hours.
const noon = new Date('2026-07-01T18:00:00Z');
const c = (id, category, priority, dedupeKey = id) => ({ id, category, priority, dedupeKey });
const h = (sentAt, category = 'reminder', dedupeKey = 'x-' + sentAt) => ({ sentAt, category, dedupeKey });
const run = (o) => planSends({ user, candidates: [], history: [], now: noon, ...o });
const rules = (r) => Object.fromEntries(r.dropped.map((d) => [d.id, d.rule]));

test('orders by priority, critical first', () => {
  const r = run({ candidates: [c('a', 'reminder', 1), c('b', 'promo', 9), c('z', 'critical', 0)] });
  assert.deepEqual(r.send, ['z', 'b', 'a']);
  assert.deepEqual(r.dropped, []);
});

test('promo dropped without opt-in', () => {
  const r = run({ user: { ...user, promoOptIn: false }, candidates: [c('p', 'promo', 5), c('r', 'reminder', 1)] });
  assert.deepEqual(r.send, ['r']);
  assert.deepEqual(rules(r), { p: 'promo-no-opt-in' });
});

test('quiet hours wrap midnight, use local time, critical bypasses', () => {
  const night = new Date('2026-07-02T04:30:00Z'); // 23:30 Chicago
  const r = run({ now: night, candidates: [c('r', 'reminder', 1), c('p', 'promo', 2), c('c', 'critical', 1)] });
  assert.deepEqual(r.send, ['c']);
  assert.deepEqual(rules(r), { r: 'quiet-hours', p: 'quiet-hours' });
  const early = new Date('2026-07-01T11:59:00Z'); // 06:59 Chicago
  assert.equal(run({ now: early, candidates: [c('r', 'reminder', 1)] }).send.length, 0);
  const edge = new Date('2026-07-01T12:00:00Z'); // 07:00 Chicago, end exclusive
  assert.deepEqual(run({ now: edge, candidates: [c('r', 'reminder', 1)] }).send, ['r']);
});

test('quiet hours without wrap, and null', () => {
  const q = { ...user, quietHours: { start: '12:00', end: '14:00' } };
  assert.equal(run({ user: q, candidates: [c('r', 'reminder', 1)] }).send.length, 0);
  assert.equal(run({ user: { ...user, quietHours: null }, now: new Date('2026-07-02T04:30:00Z'), candidates: [c('r', 'reminder', 1)] }).send.length, 1);
});

test('quiet hours follow DST (winter offset)', () => {
  const winter = new Date('2026-01-15T04:30:00Z'); // 22:30 CST
  assert.equal(run({ now: winter, candidates: [c('r', 'reminder', 1)] }).send.length, 0);
});

test('rate cap: 3 per rolling 24h, critical not counted and not capped', () => {
  const hist = [h('2026-07-01T17:00:00Z'), h('2026-07-01T10:00:00Z', 'promo'), h('2026-07-01T09:00:00Z', 'critical')];
  const r = run({ history: hist, candidates: [c('a', 'reminder', 5), c('b', 'reminder', 4), c('k', 'critical', 1)] });
  assert.deepEqual(r.send, ['k', 'a']);
  assert.deepEqual(rules(r), { b: 'rate-cap-24h' });
});

test('rate cap window: item exactly 24h old no longer counts', () => {
  const hist = [h('2026-06-30T18:00:00Z'), h('2026-07-01T01:00:00Z'), h('2026-07-01T02:00:00Z')];
  const r = run({ history: hist, candidates: [c('a', 'reminder', 1), c('b', 'reminder', 1)] });
  assert.deepEqual(r.send, ['a']); // 2 counted + 1 new = 3; the 24h-old one is outside the window
  assert.deepEqual(rules(r), { b: 'rate-cap-24h' });
});

test('dedupe vs history (7 days) and within batch', () => {
  const hist = [h('2026-06-25T18:00:01Z', 'reminder', 'k1'), h('2026-06-24T18:00:00Z', 'reminder', 'k2')];
  const r = run({ history: hist, candidates: [c('a', 'reminder', 1, 'k1'), c('b', 'reminder', 2, 'k2'), c('d1', 'reminder', 3, 'k3'), c('d2', 'reminder', 2, 'k3')] });
  assert.deepEqual(r.send, ['d1', 'b']);
  assert.deepEqual(rules(r), { a: 'dedupe-7d', d2: 'duplicate-in-batch' });
});

test('a capped candidate does not block its dedupeKey, duplicates do not use cap slots', () => {
  const hist = [h('2026-07-01T17:00:00Z'), h('2026-07-01T16:00:00Z')];
  const r = run({ history: hist, candidates: [c('a', 'reminder', 9, 'k'), c('b', 'reminder', 8, 'k'), c('c', 'reminder', 7)] });
  assert.deepEqual(r.send, ['a']);
  assert.deepEqual(rules(r), { b: 'duplicate-in-batch', c: 'rate-cap-24h' });
});

test('unknown category is dropped, every non-sent candidate appears once', () => {
  const r = run({ candidates: [c('x', 'newsletter', 1), c('a', 'reminder', 1)] });
  assert.deepEqual(r.send, ['a']);
  assert.deepEqual(r.dropped, [{ id: 'x', rule: 'unknown-category' }]);
});

test('does not mutate arguments and is deterministic', () => {
  const args = { user, candidates: [c('a', 'reminder', 1), c('b', 'critical', 0), c('c', 'promo', 5)], history: [h('2026-07-01T17:00:00Z')], now: noon };
  const copy = structuredClone(args);
  const first = planSends(args);
  assert.deepEqual(args.user, copy.user);
  assert.deepEqual(args.candidates, copy.candidates);
  assert.deepEqual(args.history, copy.history);
  assert.equal(args.now.getTime(), copy.now.getTime());
  assert.deepEqual(planSends(args), first);
});

test('invalid now or quiet hours throw', () => {
  assert.throws(() => run({ now: new Date('nope') }), TypeError);
  assert.throws(() => run({ user: { ...user, quietHours: { start: '25:00', end: '07:00' } } }), RangeError);
});
