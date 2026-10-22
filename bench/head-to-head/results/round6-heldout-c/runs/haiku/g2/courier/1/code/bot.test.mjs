import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './bot.mjs';

// Istanbul is UTC+3 with no DST. Los Angeles is UTC-7 (PDT) on 2026-10-23.
const IST = 'Europe/Istanbul';
const LA = 'America/Los_Angeles';

function marketing(userId, overrides = {}) {
  return {
    userId,
    category: 'marketing',
    timezone: IST,
    quietStart: '22:00',
    quietEnd: '07:30',
    ...overrides,
  };
}

test('transactional push is sent during quiet hours and past the cap', () => {
  const at2300 = new Date('2026-10-23T20:00:00Z'); // 23:00 Istanbul, inside quiet hours
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(
      decide({ ...marketing('tx-user'), category: 'transactional' }, at2300),
      { send: true, rule: null },
    );
  }
});

test('marketing is capped at 3 per local day', () => {
  const noon = new Date('2026-10-23T09:00:00Z'); // 12:00 Istanbul
  const results = [1, 2, 3, 4].map(() => decide(marketing('cap-user'), noon));
  assert.deepEqual(results.slice(0, 3), [
    { send: true, rule: null },
    { send: true, rule: null },
    { send: true, rule: null },
  ]);
  assert.deepEqual(results[3], { send: false, rule: 'daily-cap' });
});

test('transactional pushes do not use up the marketing cap', () => {
  const noon = new Date('2026-10-23T09:00:00Z');
  const user = 'tx-cap-user';
  for (let i = 0; i < 3; i++) {
    decide({ ...marketing(user), category: 'transactional' }, noon);
  }
  for (let i = 0; i < 3; i++) {
    assert.equal(decide(marketing(user), noon).send, true);
  }
  assert.deepEqual(decide(marketing(user), noon), { send: false, rule: 'daily-cap' });
});

test('daily cap uses the customer local day, not the UTC day', () => {
  // 05:30Z = 22:30 on Oct 22 in Los Angeles. 08:30Z = 01:30 on Oct 23 there.
  // Both instants are on Oct 23 in UTC.
  const user = 'la-user';
  const late = { ...marketing(user), timezone: LA, quietStart: '02:00', quietEnd: '03:00' };
  const earlyLocal = new Date('2026-10-23T05:30:00Z');
  const nextLocal = new Date('2026-10-23T08:30:00Z');
  for (let i = 0; i < 3; i++) {
    assert.equal(decide(late, earlyLocal).send, true);
  }
  assert.deepEqual(decide(late, earlyLocal), { send: false, rule: 'daily-cap' });
  assert.deepEqual(decide(late, nextLocal), { send: true, rule: null });
});

test('quiet window past midnight blocks marketing; end is exclusive', () => {
  const quiet = (userId) => marketing(userId);
  // 23:00 Istanbul is inside 22:00-07:30.
  assert.deepEqual(decide(quiet('qw-1'), new Date('2026-10-23T20:00:00Z')), {
    send: false,
    rule: 'quiet-hours',
  });
  // 07:29 is still inside.
  assert.deepEqual(decide(quiet('qw-2'), new Date('2026-10-23T04:29:00Z')), {
    send: false,
    rule: 'quiet-hours',
  });
  // 07:30 is outside.
  assert.deepEqual(decide(quiet('qw-3'), new Date('2026-10-23T04:30:00Z')), {
    send: true,
    rule: null,
  });
  // 22:00 is inside (start is inclusive).
  assert.deepEqual(decide(quiet('qw-4'), new Date('2026-10-23T19:00:00Z')), {
    send: false,
    rule: 'quiet-hours',
  });
});

test('quiet window that does not cross midnight', () => {
  const candidate = { ...marketing('day-window'), quietStart: '13:00', quietEnd: '14:00' };
  assert.deepEqual(decide(candidate, new Date('2026-10-23T10:30:00Z')), {
    send: false,
    rule: 'quiet-hours',
  }); // 13:30
  assert.deepEqual(decide({ ...candidate, userId: 'day-window-2' }, new Date('2026-10-23T11:00:00Z')), {
    send: true,
    rule: null,
  }); // 14:00
});

test('equal quietStart and quietEnd means no quiet window', () => {
  const candidate = { ...marketing('no-window'), quietStart: '09:00', quietEnd: '09:00' };
  assert.deepEqual(decide(candidate, new Date('2026-10-23T06:30:00Z')), { send: true, rule: null }); // 09:30
});

test('quiet-hours check runs before the daily cap, and a quiet block does not count', () => {
  const user = 'order-user';
  const noon = new Date('2026-10-23T09:00:00Z');
  const night = new Date('2026-10-23T20:00:00Z'); // 23:00
  for (let i = 0; i < 3; i++) {
    assert.equal(decide(marketing(user), noon).send, true);
  }
  // Both rules apply at night. Quiet hours are reported.
  assert.deepEqual(decide(marketing(user), night), { send: false, rule: 'quiet-hours' });
  // A quiet block does not count, so the cap still applies by day.
  assert.deepEqual(decide(marketing(user), noon), { send: false, rule: 'daily-cap' });
});

test('quiet-hour blocks do not consume the daily allowance', () => {
  const user = 'quiet-no-count';
  const night = new Date('2026-10-23T20:00:00Z');
  const day = new Date('2026-10-23T09:00:00Z');
  for (let i = 0; i < 5; i++) {
    assert.equal(decide(marketing(user), night).rule, 'quiet-hours');
  }
  assert.equal(decide(marketing(user), day).send, true);
});

test('counters are per customer', () => {
  const noon = new Date('2026-10-23T09:00:00Z');
  for (let i = 0; i < 3; i++) decide(marketing('iso-a'), noon);
  assert.equal(decide(marketing('iso-a'), noon).rule, 'daily-cap');
  assert.deepEqual(decide(marketing('iso-b'), noon), { send: true, rule: null });
});

test('invalid input throws a TypeError', () => {
  const noon = new Date('2026-10-23T09:00:00Z');
  assert.throws(() => decide(marketing('bad-1', { category: 'promo' }), noon), TypeError);
  assert.throws(() => decide(marketing('bad-2', { timezone: 'Mars/Olympus' }), noon), TypeError);
  assert.throws(() => decide(marketing('bad-3', { quietStart: '24:00' }), noon), TypeError);
  assert.throws(() => decide(marketing('bad-4', { quietEnd: '7:30' }), noon), TypeError);
  assert.throws(() => decide(marketing(''), noon), TypeError);
  assert.throws(() => decide(marketing('bad-5'), '2026-10-23'), TypeError);
  assert.throws(() => decide(marketing('bad-6'), new Date('nope')), TypeError);
});
