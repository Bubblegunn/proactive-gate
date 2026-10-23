import test from 'node:test';
import assert from 'node:assert/strict';
import { planSends } from './bot.mjs';

const now = new Date('2026-07-01T18:00:00Z'); // 13:00 in America/Chicago (CDT)
const base = { timeZone: 'America/Chicago', promoOptIn: true, quietHours: null };
const c = (id, category, priority, dedupeKey = id) => ({ id, category, priority, dedupeKey });
const run = (o) => planSends({ user: base, candidates: [], history: [], now, ...o });
const rules = (r) => Object.fromEntries(r.dropped.map((d) => [d.id, d.rule]));

test('orders by priority, best first', () => {
  const r = run({ candidates: [c('a', 'reminder', 1), c('b', 'promo', 5), c('c', 'critical', 3)] });
  assert.deepEqual(r.send, ['b', 'c', 'a']);
  assert.deepEqual(r.dropped, []);
});

test('promo needs opt-in, critical does not', () => {
  const r = run({ user: { ...base, promoOptIn: false }, candidates: [c('p', 'promo', 9), c('k', 'critical', 1)] });
  assert.deepEqual(r.send, ['k']);
  assert.deepEqual(rules(r), { p: 'no-promo-opt-in' });
});

test('cap: history counts, critical exempt, lowest priority dropped', () => {
  const history = [
    { sentAt: '2026-07-01T10:00:00Z', category: 'promo', dedupeKey: 'h1' },
    { sentAt: '2026-06-30T18:00:01Z', category: 'reminder', dedupeKey: 'h2' }, // inside 24h
    { sentAt: '2026-06-30T18:00:00Z', category: 'reminder', dedupeKey: 'h3' }, // exactly 24h: outside
    { sentAt: '2026-07-01T11:00:00Z', category: 'critical', dedupeKey: 'h4' }, // not counted
  ];
  const r = run({ history, candidates: [c('a', 'reminder', 1), c('b', 'reminder', 3), c('c', 'promo', 2), c('k', 'critical', 0)] });
  assert.deepEqual(r.send, ['b', 'k']);
  assert.deepEqual(rules(r), { c: 'frequency-cap', a: 'frequency-cap' });
});

test('dedupe 7 days: boundary and critical still covered', () => {
  const history = [
    { sentAt: '2026-06-24T18:00:01Z', category: 'reminder', dedupeKey: 'x' },
    { sentAt: '2026-06-24T18:00:00Z', category: 'reminder', dedupeKey: 'y' }, // exactly 7d: allowed
    { sentAt: '2026-06-30T00:00:00Z', category: 'critical', dedupeKey: 'z' },
  ];
  const r = run({ history, candidates: [c('1', 'reminder', 1, 'x'), c('2', 'reminder', 1, 'y'), c('3', 'critical', 1, 'z')] });
  assert.deepEqual(r.send, ['2']);
  assert.deepEqual(rules(r), { 1: 'dedupe-7d', 3: 'dedupe-7d' });
});

test('duplicate keys in one batch keep the best; held duplicate does not suppress', () => {
  const r = run({ candidates: [c('a', 'reminder', 1, 'k'), c('b', 'reminder', 2, 'k')] });
  assert.deepEqual(r.send, ['b']);
  assert.deepEqual(rules(r), { a: 'duplicate-in-batch' });
  const q = run({
    user: { ...base, quietHours: { start: '12:00', end: '14:00' } },
    candidates: [c('a', 'reminder', 9, 'k'), c('b', 'critical', 1, 'k')],
  });
  assert.deepEqual(q.send, ['b']);
});

test('quiet hours: local time, midnight wrap, critical bypass, DST zone', () => {
  const user = { ...base, quietHours: { start: '22:00', end: '07:00' } };
  const cands = [c('r', 'reminder', 1), c('k', 'critical', 1)];
  // 13:00 Chicago: allowed
  assert.deepEqual(run({ user, candidates: cands }).send, ['k', 'r']); // equal priority: critical first
  // 03:00 Chicago (08:00Z): quiet, even though 08:00 UTC would be outside
  let r = run({ user, candidates: cands, now: new Date('2026-07-01T08:00:00Z') });
  assert.deepEqual(r.send, ['k']);
  assert.deepEqual(rules(r), { r: 'quiet-hours' });
  // 22:00 start inclusive, 07:00 end exclusive
  r = run({ user, candidates: cands, now: new Date('2026-07-02T03:00:00Z') }); // 22:00 CDT
  assert.deepEqual(rules(r), { r: 'quiet-hours' });
  r = run({ user, candidates: cands, now: new Date('2026-07-01T12:00:00Z') }); // 07:00 CDT
  assert.deepEqual(r.dropped, []);
  // winter: same UTC instant is one hour earlier locally (CST)
  r = run({ user, candidates: cands, now: new Date('2026-01-01T04:00:00Z') }); // 22:00 CST prev day
  assert.deepEqual(rules(r), { r: 'quiet-hours' });
  // same-day window and tz far from UTC
  const tokyo = { timeZone: 'Asia/Tokyo', promoOptIn: true, quietHours: { start: '09:00', end: '10:00' } };
  r = run({ user: tokyo, candidates: [c('r', 'reminder', 1)], now: new Date('2026-07-01T00:30:00Z') });
  assert.deepEqual(rules(r), { r: 'quiet-hours' });
});

test('bad settings fail closed for non-critical only', () => {
  const cands = [c('r', 'reminder', 1), c('k', 'critical', 1)];
  let r = run({ user: { ...base, timeZone: 'Mars/Base', quietHours: { start: '22:00', end: '07:00' } }, candidates: cands });
  assert.deepEqual(r.send, ['k']);
  assert.deepEqual(rules(r), { r: 'unknown-time-zone' });
  r = run({ user: { ...base, quietHours: { start: '25:00', end: '07:00' } }, candidates: cands });
  assert.deepEqual(rules(r), { r: 'invalid-quiet-hours' });
  r = run({ candidates: [c('x', 'newsletter', 1)] });
  assert.deepEqual(rules(r), { x: 'unknown-category' });
});

test('does not mutate arguments and every candidate appears once', () => {
  const args = {
    user: { ...base, quietHours: { start: '22:00', end: '07:00' } },
    candidates: [c('a', 'reminder', 1), c('b', 'promo', 5), c('c', 'critical', 3), c('d', 'reminder', 2, 'a')],
    history: [{ sentAt: '2026-07-01T10:00:00Z', category: 'promo', dedupeKey: 'zz' }],
    now,
  };
  const copy = structuredClone(args);
  Object.freeze(args.candidates);
  const r = planSends(args);
  assert.deepEqual({ ...args, now: args.now.getTime() }, { ...copy, now: copy.now.getTime() });
  const ids = [...r.send, ...r.dropped.map((d) => d.id)].sort();
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
});
