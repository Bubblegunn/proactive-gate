import test from 'node:test';
import assert from 'node:assert/strict';
import { planSends } from './bot.mjs';

const now = new Date('2026-10-23T18:00:00Z'); // 13:00 Chicago (CDT), 14:00 New York
const user = { timeZone: 'America/Chicago', promoOptIn: true, quietHours: null };
const c = (id, category, priority, dedupeKey = id) => ({ id, category, priority, dedupeKey });
const h = (hoursAgo, category, dedupeKey) => ({
  sentAt: new Date(now.getTime() - hoursAgo * 3600e3).toISOString(),
  category,
  dedupeKey,
});
const plan = (over) => planSends({ user, candidates: [], history: [], now, ...over });

test('orders by priority and drops over the 3 per 24h cap', () => {
  const r = plan({
    candidates: [c('a', 'reminder', 1), c('b', 'promo', 5), c('c', 'reminder', 3), c('d', 'reminder', 2)],
  });
  assert.deepEqual(r.send, ['b', 'c', 'd']);
  assert.deepEqual(r.dropped, [{ id: 'a', rule: 'cap-3-per-24h' }]);
});

test('history counts toward the rolling cap; 24h boundary is outside', () => {
  const history = [h(1, 'promo', 'x'), h(23.9, 'reminder', 'y'), h(24, 'reminder', 'z'), h(2, 'critical', 'w')];
  const r = plan({ history, candidates: [c('a', 'reminder', 2), c('b', 'reminder', 1)] });
  assert.deepEqual(r.send, ['a']);
  assert.deepEqual(r.dropped, [{ id: 'b', rule: 'cap-3-per-24h' }]);
});

test('critical ignores cap, quiet hours, and does not consume the cap', () => {
  const u = { ...user, quietHours: { start: '12:00', end: '14:00' } };
  const history = [h(1, 'promo', 'x'), h(2, 'promo', 'y'), h(3, 'promo', 'z')];
  const r = planSends({
    user: u, history, now,
    candidates: [c('crit', 'critical', 1), c('rem', 'reminder', 9)],
  });
  assert.deepEqual(r.send, ['crit']);
  assert.deepEqual(r.dropped, [{ id: 'rem', rule: 'quiet-hours' }]);
  const r2 = plan({ history, candidates: [c('crit', 'critical', 1), c('rem', 'reminder', 9)] });
  assert.deepEqual(r2.send, ['crit']);
  assert.equal(r2.dropped[0].rule, 'cap-3-per-24h');
});

test('promo without opt-in is dropped, critical and reminder unaffected', () => {
  const r = planSends({
    user: { ...user, promoOptIn: false }, history: [], now,
    candidates: [c('p', 'promo', 9), c('r', 'reminder', 1)],
  });
  assert.deepEqual(r.send, ['r']);
  assert.deepEqual(r.dropped, [{ id: 'p', rule: 'promo-not-opted-in' }]);
});

test('quiet hours use the user time zone and wrap midnight', () => {
  const q = { ...user, quietHours: { start: '22:00', end: '07:00' } };
  const at = (iso) => planSends({ user: q, history: [], now: new Date(iso), candidates: [c('r', 'reminder', 1)] });
  assert.equal(at('2026-10-24T03:30:00Z').dropped[0]?.rule, 'quiet-hours'); // 22:30 Chicago
  assert.equal(at('2026-10-24T11:59:00Z').dropped[0]?.rule, 'quiet-hours'); // 06:59 Chicago
  assert.deepEqual(at('2026-10-24T12:00:00Z').send, ['r']); // 07:00 Chicago, end exclusive
  assert.deepEqual(at('2026-10-24T20:00:00Z').send, ['r']); // 15:00 Chicago
});

test('7-day dedupe against history and inside the batch', () => {
  const history = [h(24 * 6.9, 'reminder', 'k'), h(24 * 7, 'reminder', 'old')];
  const r = plan({
    history,
    candidates: [c('a', 'reminder', 1, 'k'), c('b', 'reminder', 2, 'old'), c('c', 'reminder', 3, 'old')],
  });
  assert.deepEqual(r.send, ['c']);
  assert.deepEqual(r.dropped, [
    { id: 'a', rule: 'dedupe-7-days' },
    { id: 'b', rule: 'dedupe-in-batch' },
  ]);
});

test('does not mutate arguments', () => {
  const args = {
    user: { ...user, quietHours: { start: '01:00', end: '02:00' } },
    candidates: [c('a', 'reminder', 1), c('b', 'reminder', 2)],
    history: [h(1, 'promo', 'x')],
    now,
  };
  const snap = structuredClone({ ...args, now: now.getTime() });
  planSends(args);
  assert.deepEqual(structuredClone({ ...args, now: args.now.getTime() }), snap);
});

test('every candidate is in send or dropped exactly once', () => {
  const cs = [c('a', 'promo', 1), c('b', 'bogus', 1), c('d', 'reminder', NaN), c('e', 'critical', 0)];
  const r = plan({ candidates: cs });
  assert.deepEqual([...r.send, ...r.dropped.map((d) => d.id)].sort(), ['a', 'b', 'd', 'e']);
});
