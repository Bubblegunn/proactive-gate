import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './bot.mjs';

const marketing = (userId, extra = {}) => ({
  userId,
  category: 'marketing',
  timezone: 'Europe/Istanbul', // UTC+3, no DST
  quietStart: '22:00',
  quietEnd: '07:30',
  ...extra,
});

const transactional = (userId, extra = {}) => ({ ...marketing(userId), category: 'transactional', ...extra });

// Local Istanbul times on 2026-10-23 expressed in UTC.
const at = (iso) => new Date(iso);

test('transactional is sent during quiet hours and above the cap', () => {
  const now = at('2026-10-23T19:30:00Z'); // 22:30 local
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(decide(transactional('t1'), now), { send: true, rule: null });
  }
});

test('transactional does not consume the marketing cap', () => {
  const now = at('2026-10-23T10:00:00Z'); // 13:00 local
  for (let i = 0; i < 10; i++) decide(transactional('t2'), now);
  for (let i = 0; i < 3; i++) assert.equal(decide(marketing('t2'), now).send, true);
  assert.deepEqual(decide(marketing('t2'), now), { send: false, rule: 'daily-cap' });
});

test('fourth marketing push in one local day is blocked with daily-cap', () => {
  const now = at('2026-10-23T10:00:00Z');
  for (let i = 0; i < 3; i++) assert.deepEqual(decide(marketing('cap'), now), { send: true, rule: null });
  assert.deepEqual(decide(marketing('cap'), now), { send: false, rule: 'daily-cap' });
});

test('cap is per customer', () => {
  const now = at('2026-10-23T10:00:00Z');
  for (let i = 0; i < 3; i++) decide(marketing('a'), now);
  assert.equal(decide(marketing('a'), now).rule, 'daily-cap');
  assert.deepEqual(decide(marketing('b'), now), { send: true, rule: null });
});

test('cap resets at the customer local midnight, not UTC midnight', () => {
  // 2026-10-23 21:30 UTC is 2026-10-24 00:30 in Istanbul.
  // Quiet window moved to 02:00-03:00 so it does not hide the cap at these times.
  const quiet = { quietStart: '02:00', quietEnd: '03:00' };
  const beforeMidnight = at('2026-10-23T20:50:00Z'); // 23:50 local on the 23rd
  const afterMidnight = at('2026-10-23T21:30:00Z'); // 00:30 local on the 24th
  for (let i = 0; i < 3; i++) decide(marketing('mid', quiet), beforeMidnight);
  assert.equal(decide(marketing('mid', quiet), beforeMidnight).rule, 'daily-cap');
  assert.deepEqual(decide(marketing('mid', quiet), afterMidnight), { send: true, rule: null });
});

test('quiet window across midnight: inside blocked, end is exclusive', () => {
  assert.deepEqual(decide(marketing('q1'), at('2026-10-23T19:30:00Z')), { send: false, rule: 'quiet-hours' }); // 22:30
  assert.deepEqual(decide(marketing('q2'), at('2026-10-23T20:59:00Z')), { send: false, rule: 'quiet-hours' }); // 23:59 local
  assert.deepEqual(decide(marketing('q3'), at('2026-10-24T01:00:00Z')), { send: false, rule: 'quiet-hours' }); // 04:00 local
  assert.deepEqual(decide(marketing('q4'), at('2026-10-24T04:29:00Z')), { send: false, rule: 'quiet-hours' }); // 07:29 local
  assert.deepEqual(decide(marketing('q5'), at('2026-10-24T04:30:00Z')), { send: true, rule: null }); // 07:30 local
});

test('quiet window that does not cross midnight', () => {
  const lunch = { quietStart: '13:00', quietEnd: '14:00' };
  assert.equal(decide(marketing('n1', lunch), at('2026-10-23T10:30:00Z')).rule, 'quiet-hours'); // 13:30
  assert.equal(decide(marketing('n2', lunch), at('2026-10-23T11:00:00Z')).send, true); // 14:00
  assert.equal(decide(marketing('n3', lunch), at('2026-10-23T09:00:00Z')).send, true); // 12:00
});

test('equal start and end means no quiet hours', () => {
  const same = { quietStart: '08:00', quietEnd: '08:00' };
  assert.equal(decide(marketing('e1', same), at('2026-10-23T05:00:00Z')).send, true); // 08:00 local
});

test('quiet-hours block does not consume the daily cap', () => {
  const night = at('2026-10-23T19:30:00Z'); // 22:30 local
  const day = at('2026-10-23T10:00:00Z'); // 13:00 local
  for (let i = 0; i < 5; i++) assert.equal(decide(marketing('qc'), night).rule, 'quiet-hours');
  for (let i = 0; i < 3; i++) assert.equal(decide(marketing('qc'), day).send, true);
  assert.equal(decide(marketing('qc'), day).rule, 'daily-cap');
});

test('the same instant gives different local answers for different zones', () => {
  const now = at('2026-10-23T19:30:00Z');
  // Istanbul 22:30 is quiet; New York 15:30 is not.
  assert.equal(decide(marketing('z1', { timezone: 'Europe/Istanbul' }), now).rule, 'quiet-hours');
  assert.equal(decide(marketing('z2', { timezone: 'America/New_York' }), now).send, true);
});

test('invalid input throws instead of guessing', () => {
  const now = at('2026-10-23T10:00:00Z');
  assert.throws(() => decide(marketing('x', { timezone: 'Mars/Olympus' }), now), RangeError);
  assert.throws(() => decide(marketing('x', { quietStart: '24:00' }), now), TypeError);
  assert.throws(() => decide(marketing('x', { category: 'promo' }), now), TypeError);
  assert.throws(() => decide(marketing(''), now), TypeError);
  assert.throws(() => decide(marketing('x'), new Date('nope')), TypeError);
});
