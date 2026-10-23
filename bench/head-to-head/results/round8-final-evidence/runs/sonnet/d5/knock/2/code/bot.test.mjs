import test from 'node:test';
import assert from 'node:assert/strict';
import { planSends } from './bot.mjs';

// 2026-03-10T18:00Z = 13:00 in Chicago (CDT), 03:00 next day in Tokyo.
const now = new Date('2026-03-10T18:00:00Z');
const user = (o = {}) => ({ timeZone: 'America/Chicago', promoOptIn: true, quietHours: null, ...o });
const c = (id, category, priority, dedupeKey = id) => ({ id, category, priority, dedupeKey });
const run = (o) => planSends({ user: user(), candidates: [], history: [], now, ...o });
const rules = (r) => Object.fromEntries(r.dropped.map((d) => [d.id, d.rule]));

test('orders by priority, stable on ties', () => {
  const r = run({ candidates: [c('a', 'reminder', 1), c('b', 'reminder', 5), c('c', 'reminder', 5)] });
  assert.deepEqual(r.send, ['b', 'c', 'a']);
});

test('promo without opt-in is held, critical and reminder are not', () => {
  const r = run({ user: user({ promoOptIn: false }), candidates: [c('p', 'promo', 9), c('r', 'reminder', 1), c('x', 'critical', 1)] });
  assert.deepEqual(r.send, ['r', 'x']);
  assert.deepEqual(r.dropped, [{ id: 'p', rule: 'promo-no-opt-in' }]);
});

test('quiet hours use the customer time zone, wrap midnight, and critical bypasses', () => {
  const q = { start: '22:00', end: '14:00' }; // Chicago 13:00 is inside
  const r = run({ user: user({ quietHours: q }), candidates: [c('r', 'reminder', 1), c('x', 'critical', 1)] });
  assert.deepEqual(r.send, ['x']);
  assert.equal(rules(r).r, 'quiet-hours');
  // Same instant in Tokyo (03:00) with a 09:00-17:00 window is outside it.
  const t = run({ user: user({ timeZone: 'Asia/Tokyo', quietHours: { start: '09:00', end: '17:00' } }), candidates: [c('r', 'reminder', 1)] });
  assert.deepEqual(t.send, ['r']);
  // End is exclusive: 13:00 with window 09:00-13:00 is allowed.
  const e = run({ user: user({ quietHours: { start: '09:00', end: '13:00' } }), candidates: [c('r', 'reminder', 1)] });
  assert.deepEqual(e.send, ['r']);
});

test('quiet hours respect DST (Chicago 2026-03-08 spring forward)', () => {
  const after = new Date('2026-03-08T08:30:00Z'); // 03:30 CDT
  const r = planSends({ user: user({ quietHours: { start: '03:00', end: '04:00' } }), candidates: [c('r', 'reminder', 1)], history: [], now: after });
  assert.equal(rules(r).r, 'quiet-hours');
});

test('24h cap counts reminders and promos, not critical; window is rolling', () => {
  const h = (hoursAgo, category = 'reminder', k = `h${hoursAgo}`) => ({ sentAt: new Date(now - hoursAgo * 3600e3).toISOString(), category, dedupeKey: k });
  const history = [h(1), h(5, 'promo'), h(23.9), h(25), h(2, 'critical')];
  const r = run({ history, candidates: [c('a', 'reminder', 2), c('b', 'promo', 1), c('x', 'critical', 0)] });
  assert.deepEqual(r.send, ['x']); // 1h, 5h, 23.9h count; 25h and critical do not
  assert.deepEqual(rules(r), { a: 'frequency-cap-24h', b: 'frequency-cap-24h' });
  const r2 = run({ history: history.slice(0, 2), candidates: [c('a', 'reminder', 2), c('b', 'promo', 1)] });
  assert.deepEqual(r2.send, ['a']);
  assert.deepEqual(rules(r2), { b: 'frequency-cap-24h' });
});

test('cap leaves slots for the highest priority only', () => {
  const r = run({ candidates: [c('a', 'reminder', 1), c('b', 'promo', 4), c('c', 'reminder', 3), c('d', 'reminder', 2), c('x', 'critical', 0)] });
  assert.deepEqual(r.send, ['b', 'c', 'd', 'x']);
  assert.deepEqual(r.dropped, [{ id: 'a', rule: 'frequency-cap-24h' }]);
});

test('dedupe: 7-day history window and same batch; held ones do not block others', () => {
  const history = [
    { sentAt: new Date(now - 6.9 * 864e5).toISOString(), category: 'reminder', dedupeKey: 'k1' },
    { sentAt: new Date(now - 7.1 * 864e5).toISOString(), category: 'reminder', dedupeKey: 'k2' },
  ];
  const r = run({ history, candidates: [c('a', 'reminder', 1, 'k1'), c('b', 'reminder', 1, 'k2'), c('c', 'reminder', 3, 'k3'), c('d', 'reminder', 2, 'k3')] });
  assert.deepEqual(r.send, ['c', 'b']);
  assert.deepEqual(rules(r), { a: 'dedupe-7d', d: 'dedupe-same-batch' });
});

test('every candidate appears exactly once; reasons are distinct per cause', () => {
  const candidates = [c('p', 'promo', 1), c('z', 'weird', 1), c('r', 'reminder', 1)];
  const r = run({ user: user({ promoOptIn: false }), candidates });
  assert.equal(r.send.length + r.dropped.length, 3);
  assert.deepEqual(rules(r), { p: 'promo-no-opt-in', z: 'unknown-category' });
});

test('does not mutate arguments', () => {
  const args = {
    user: user({ quietHours: { start: '22:00', end: '06:00' } }),
    candidates: [c('a', 'reminder', 1), c('b', 'reminder', 2)],
    history: [{ sentAt: '2026-03-10T10:00:00Z', category: 'reminder', dedupeKey: 'h' }],
    now,
  };
  const copy = structuredClone(args);
  planSends(args);
  assert.deepEqual(args, copy);
});
