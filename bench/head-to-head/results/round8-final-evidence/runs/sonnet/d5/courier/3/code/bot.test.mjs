import test from 'node:test';
import assert from 'node:assert/strict';
import { planSends } from './bot.mjs';

const NOW = new Date('2026-10-23T18:00:00Z'); // 13:00 in Chicago (CDT), 03:00 next day in Tokyo
const user = (o = {}) => ({ timeZone: 'America/Chicago', promoOptIn: true, quietHours: null, ...o });
const cand = (id, category, priority, key = id) => ({ id, category, priority, dedupeKey: key });
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const H = 3600e3;
const run = (o) => planSends({ user: user(), candidates: [], history: [], now: NOW, ...o });

test('orders by priority, stable on ties', () => {
  const r = run({ candidates: [cand('a', 'reminder', 1), cand('b', 'reminder', 5), cand('c', 'reminder', 1)] });
  assert.deepEqual(r.send, ['b', 'a', 'c']);
});

test('promo without opt-in is dropped, reminder is not', () => {
  const r = run({ user: user({ promoOptIn: false }), candidates: [cand('p', 'promo', 9), cand('r', 'reminder', 1)] });
  assert.deepEqual(r.send, ['r']);
  assert.deepEqual(r.dropped, [{ id: 'p', rule: 'promo-no-opt-in' }]);
});

test('quiet hours across midnight, in the user zone', () => {
  const q = { start: '22:00', end: '07:00' };
  const tokyo = user({ timeZone: 'Asia/Tokyo', quietHours: q }); // 03:00 local
  assert.deepEqual(run({ user: tokyo, candidates: [cand('r', 'reminder', 1)] }).dropped, [{ id: 'r', rule: 'quiet-hours' }]);
  const chicago = user({ quietHours: q }); // 13:00 local
  assert.deepEqual(run({ user: chicago, candidates: [cand('r', 'reminder', 1)] }).send, ['r']);
});

test('quiet hours: start inclusive, end exclusive, same-day window', () => {
  const q = user({ timeZone: 'UTC', quietHours: { start: '18:00', end: '19:00' } });
  assert.equal(run({ user: q, candidates: [cand('r', 'reminder', 1)] }).send.length, 0);
  const q2 = user({ timeZone: 'UTC', quietHours: { start: '17:00', end: '18:00' } });
  assert.equal(run({ user: q2, candidates: [cand('r', 'reminder', 1)] }).send.length, 1);
});

test('critical ignores quiet hours, cap, and opt-in; does not use cap slots', () => {
  const hist = [1, 2, 3].map((i) => ({ sentAt: ago(i * H), category: 'reminder', dedupeKey: 'h' + i }));
  const r = run({
    user: user({ timeZone: 'Asia/Tokyo', promoOptIn: false, quietHours: { start: '22:00', end: '07:00' } }),
    candidates: [cand('fraud', 'critical', 1), cand('r', 'reminder', 9)],
    history: hist,
  });
  assert.deepEqual(r.send, ['fraud']);
  assert.deepEqual(r.dropped, [{ id: 'r', rule: 'quiet-hours' }]);
});

test('cap of 3 per rolling 24h counts history, promo and reminder together', () => {
  const history = [
    { sentAt: ago(1 * H), category: 'promo', dedupeKey: 'x1' },
    { sentAt: ago(23 * H), category: 'reminder', dedupeKey: 'x2' },
    { sentAt: ago(25 * H), category: 'reminder', dedupeKey: 'x3' }, // outside window
    { sentAt: ago(2 * H), category: 'critical', dedupeKey: 'x4' }, // not counted
  ];
  const r = run({ history, candidates: [cand('a', 'reminder', 3), cand('b', 'promo', 2), cand('c', 'reminder', 1)] });
  assert.deepEqual(r.send, ['a']);
  assert.deepEqual(r.dropped, [
    { id: 'b', rule: 'rate-limit-24h' },
    { id: 'c', rule: 'rate-limit-24h' },
  ]);
});

test('exactly 24h old no longer counts', () => {
  const history = [1, 2, 3].map((i) => ({ sentAt: ago(24 * H), category: 'reminder', dedupeKey: 'o' + i }));
  assert.deepEqual(run({ history, candidates: [cand('a', 'reminder', 1)] }).send, ['a']);
});

test('7-day dedupe against history; exactly 7 days is allowed again', () => {
  const history = [
    { sentAt: ago(6.9 * 24 * H), category: 'reminder', dedupeKey: 'k1' },
    { sentAt: ago(7 * 24 * H), category: 'reminder', dedupeKey: 'k2' },
  ];
  const r = run({ history, candidates: [cand('a', 'reminder', 2, 'k1'), cand('b', 'reminder', 1, 'k2')] });
  assert.deepEqual(r.send, ['b']);
  assert.deepEqual(r.dropped, [{ id: 'a', rule: 'dedupe-7d' }]);
});

test('same dedupeKey inside one batch: best wins, other has its own rule', () => {
  const r = run({ candidates: [cand('lo', 'reminder', 1, 'k'), cand('hi', 'reminder', 2, 'k')] });
  assert.deepEqual(r.send, ['hi']);
  assert.deepEqual(r.dropped, [{ id: 'lo', rule: 'dedupe-same-batch' }]);
});

test('a dropped candidate does not reserve its key or a cap slot', () => {
  const r = run({
    user: user({ promoOptIn: false }),
    candidates: [cand('p', 'promo', 9, 'k'), cand('r', 'reminder', 1, 'k')],
  });
  assert.deepEqual(r.send, ['r']);
});

test('every candidate is in exactly one of send/dropped; distinct rules; no mutation', () => {
  const input = {
    user: user({ promoOptIn: false }),
    candidates: [cand('a', 'promo', 5), cand('b', 'reminder', 4), cand('c', 'critical', 1), cand('d', 'weird', 9)],
    history: [{ sentAt: ago(H), category: 'reminder', dedupeKey: 'b' }],
    now: NOW,
  };
  const snap = structuredClone(input);
  const r = planSends(input);
  assert.deepEqual(input, snap);
  assert.deepEqual(r.send, ['c']);
  assert.deepEqual(new Set(r.dropped.map((d) => d.id)), new Set(['a', 'b', 'd']));
  assert.equal(new Set(r.dropped.map((d) => d.rule)).size, 3);
});
