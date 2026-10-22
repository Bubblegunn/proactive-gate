import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSms } from './bot.mjs';

const PHONE = '+13125550142';
const user = (timezone, phone = PHONE) => ({ id: 'u_123', phone, timezone });
const userWithPhone = (phone) => ({ id: 'u_123', phone, timezone: 'America/Chicago' });

test('allowed at 14:00 Chicago (CDT)', () => {
  const r = checkSms(user('America/Chicago'), new Date('2026-10-23T19:00:00Z'));
  assert.equal(r.allowed, true);
  assert.equal(r.nextAllowedAt, null);
  assert.equal(typeof r.reason, 'string');
});

test('08:00 local is allowed, 07:59:59.999 is held until 08:00 same day', () => {
  // Chicago CDT = UTC-5 on 2026-10-23
  assert.equal(checkSms(user('America/Chicago'), new Date('2026-10-23T13:00:00Z')).allowed, true);
  const early = checkSms(user('America/Chicago'), new Date('2026-10-23T12:59:59.999Z'));
  assert.equal(early.allowed, false);
  assert.equal(early.nextAllowedAt.toISOString(), '2026-10-23T13:00:00.000Z');
});

test('20:59:59.999 is allowed, 21:00 is held until 08:00 next day', () => {
  assert.equal(checkSms(user('America/Chicago'), new Date('2026-10-24T01:59:59.999Z')).allowed, true);
  const late = checkSms(user('America/Chicago'), new Date('2026-10-24T02:00:00Z'));
  assert.equal(late.allowed, false);
  assert.equal(late.nextAllowedAt.toISOString(), '2026-10-24T13:00:00.000Z');
  assert.match(late.reason, /21:00 in America\/Chicago|Held/);
});

test('half-hour zone: Asia/Kolkata (UTC+5:30) boundary at 02:30Z', () => {
  const before = checkSms(user('Asia/Kolkata'), new Date('2026-10-23T02:29:59.999Z'));
  assert.equal(before.allowed, false);
  assert.equal(before.nextAllowedAt.toISOString(), '2026-10-23T02:30:00.000Z');
  assert.equal(checkSms(user('Asia/Kolkata'), new Date('2026-10-23T02:30:00Z')).allowed, true);
});

test('fall-back DST day in Chicago (2026-11-01): next 08:00 is CST', () => {
  // 21:30 CDT on Oct 31 -> next 08:00 local on Nov 1 is CST (UTC-6) = 14:00Z
  const r = checkSms(user('America/Chicago'), new Date('2026-11-01T02:30:00Z'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-11-01T14:00:00.000Z');
});

test('spring-forward DST day in Chicago (2026-03-08): next 08:00 is CDT', () => {
  // 22:00 CST on Mar 7 = 04:00Z Mar 8 -> next 08:00 CDT Mar 8 = 13:00Z
  const r = checkSms(user('America/Chicago'), new Date('2026-03-08T04:00:00Z'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-03-08T13:00:00.000Z');
});

test('month rollover: 22:00 on Oct 31 in New York -> Nov 1 08:00', () => {
  const r = checkSms(user('America/New_York'), new Date('2026-11-01T02:00:00Z'));
  assert.equal(r.allowed, false);
  // Oct 31 22:00 EDT = Nov 1 02:00Z; next 08:00 EST Nov 1 = 13:00Z
  assert.equal(r.nextAllowedAt.toISOString(), '2026-11-01T13:00:00.000Z');
});

test('null, empty, and unknown time zones are held with nextAllowedAt null', () => {
  for (const tz of [null, undefined, '', 'Mars/Olympus_Mons', 'not a zone']) {
    const r = checkSms(user(tz), new Date('2026-10-23T19:00:00Z'));
    assert.equal(r.allowed, false, `tz=${tz}`);
    assert.equal(r.nextAllowedAt, null, `tz=${tz}`);
    assert.equal(typeof r.reason, 'string');
  }
});

test('malformed phone is held with nextAllowedAt null', () => {
  for (const phone of ['3125550142', '+0123', '', undefined, 42]) {
    const r = checkSms(userWithPhone(phone), new Date('2026-10-23T19:00:00Z'));
    assert.equal(r.allowed, false, `phone=${phone}`);
    assert.equal(r.nextAllowedAt, null, `phone=${phone}`);
  }
});

test('invalid now or user throws', () => {
  assert.throws(() => checkSms(user('America/Chicago'), new Date('nope')), TypeError);
  assert.throws(() => checkSms(user('America/Chicago'), '2026-10-23'), TypeError);
  assert.throws(() => checkSms(null, new Date()), TypeError);
});

test('property: nextAllowedAt is exactly the first allowed instant, for many zones and a full year', () => {
  const zones = [
    'America/Chicago', 'America/New_York', 'America/Los_Angeles', 'America/Anchorage',
    'Pacific/Honolulu', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Adelaide',
    'Europe/London', 'Pacific/Chatham', 'America/St_Johns',
  ];
  const start = Date.UTC(2026, 0, 1);
  const end = Date.UTC(2027, 0, 1);
  let held = 0;
  for (const tz of zones) {
    for (let t = start; t < end; t += 311 * 60 * 1000 + 13 * 1000) {
      const now = new Date(t);
      const r = checkSms(user(tz), now);
      if (r.allowed) continue;
      held++;
      const next = r.nextAllowedAt;
      assert.ok(next.getTime() > t, `${tz} ${now.toISOString()} next must be in the future`);
      assert.equal(checkSms(user(tz), next).allowed, true, `${tz} at next ${next.toISOString()}`);
      assert.equal(
        checkSms(user(tz), new Date(next.getTime() - 1)).allowed,
        false,
        `${tz} one ms before next ${next.toISOString()}`,
      );
    }
  }
  assert.ok(held > 0);
});
