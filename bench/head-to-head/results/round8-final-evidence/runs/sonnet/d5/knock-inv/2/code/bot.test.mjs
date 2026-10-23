import test from 'node:test';
import assert from 'node:assert/strict';
import { planSends } from './bot.mjs';

const base = { timeZone: 'America/Chicago', promoOptIn: true, quietHours: null };
const c = (id, category, priority, dedupeKey = id) => ({ id, category, priority, dedupeKey });
const now = new Date('2026-10-23T18:00:00Z'); // 13:00 Chicago (CDT)
const plan = (o) => planSends({ user: base, candidates: [], history: [], now, ...o });

test('orders by priority, critical first', () => {
  const r = plan({ candidates: [c('a', 'reminder', 1), c('b', 'promo', 9), c('z', 'critical', 0)] });
  assert.deepEqual(r.send, ['z', 'b', 'a']);
  assert.deepEqual(r.dropped, []);
});

test('promo without opt-in is dropped, critical and reminder are not', () => {
  const r = plan({ user: { ...base, promoOptIn: false }, candidates: [c('p', 'promo', 5), c('r', 'reminder', 1)] });
  assert.deepEqual(r.send, ['r']);
  assert.deepEqual(r.dropped, [{ id: 'p', rule: 'promo-not-opted-in' }]);
});

test('quiet hours across midnight use local time; critical bypasses', () => {
  const q = { ...base, quietHours: { start: '22:00', end: '07:00' } };
  const night = new Date('2026-10-24T03:30:00Z'); // 22:30 Chicago
  const r = planSends({ user: q, candidates: [c('r', 'reminder', 1), c('x', 'critical', 1)], history: [], now: night });
  assert.deepEqual(r.send, ['x']);
  assert.deepEqual(r.dropped, [{ id: 'r', rule: 'quiet-hours' }]);
  // 13:00 local is outside the window; end is exclusive (07:00 sends)
  assert.deepEqual(planSends({ user: q, candidates: [c('r', 'reminder', 1)], history: [], now }).send, ['r']);
  const seven = new Date('2026-10-24T12:00:00Z'); // 07:00 CDT
  assert.deepEqual(planSends({ user: q, candidates: [c('r', 'reminder', 1)], history: [], now: seven }).send, ['r']);
});

test('same-day quiet window and UTC-vs-local difference', () => {
  const q = { ...base, quietHours: { start: '12:00', end: '14:00' } };
  assert.equal(planSends({ user: q, candidates: [c('r', 'reminder', 1)], history: [], now }).dropped[0].rule, 'quiet-hours');
});

test('cap 3 per rolling 24h counts history, ignores critical, frees after 24h', () => {
  const h = (hoursAgo, category, key) => ({ sentAt: new Date(now.getTime() - hoursAgo * 3600e3).toISOString(), category, dedupeKey: key });
  const history = [h(1, 'promo', 'h1'), h(5, 'reminder', 'h2'), h(23.9, 'reminder', 'h3'), h(2, 'critical', 'h4'), h(24.1, 'promo', 'h5')];
  const r = plan({ history, candidates: [c('a', 'reminder', 2), c('b', 'promo', 1), c('s', 'critical', 0)] });
  assert.deepEqual(r.send, ['s']);
  assert.deepEqual(r.dropped.map((d) => d.rule), ['daily-cap', 'daily-cap']);
  const r2 = plan({ history: history.slice(0, 2), candidates: [c('a', 'reminder', 2), c('b', 'promo', 1)] });
  assert.deepEqual(r2.send, ['a']);
  assert.deepEqual(r2.dropped, [{ id: 'b', rule: 'daily-cap' }]);
});

test('dedupe 7 days against history and inside the batch', () => {
  const day = (d) => new Date(now.getTime() - d * DAY).toISOString();
  const DAY = 86400e3;
  const history = [{ sentAt: day(6.9), category: 'reminder', dedupeKey: 'k1' }, { sentAt: day(7.1), category: 'reminder', dedupeKey: 'k2' }];
  const r = plan({
    history,
    candidates: [c('a', 'reminder', 1, 'k1'), c('b', 'reminder', 1, 'k2'), c('c', 'promo', 2, 'k3'), c('d', 'reminder', 1, 'k3')],
  });
  assert.deepEqual(r.send, ['c', 'b']);
  assert.deepEqual(r.dropped, [{ id: 'a', rule: 'dedupe-7d' }, { id: 'd', rule: 'dedupe-in-batch' }]);
});

test('does not mutate arguments', () => {
  const args = {
    user: { ...base, quietHours: { start: '22:00', end: '07:00' } },
    candidates: [c('a', 'reminder', 1), c('b', 'critical', 5)],
    history: [{ sentAt: '2026-10-23T10:00:00Z', category: 'promo', dedupeKey: 'x' }],
    now,
  };
  const copy = structuredClone({ ...args, now: undefined });
  const t = now.getTime();
  planSends(args);
  assert.deepEqual({ ...args, now: undefined }, copy);
  assert.equal(now.getTime(), t);
});

test('every candidate is in exactly one place', () => {
  const cands = [c('a', 'promo', 1), c('b', 'weird', 1), c('c', 'reminder', 1)];
  const r = plan({ user: { ...base, promoOptIn: false }, candidates: cands });
  assert.equal(r.send.length + r.dropped.length, 3);
  assert.deepEqual(r.dropped.map((d) => d.rule), ['promo-not-opted-in', 'unknown-category']);
});
