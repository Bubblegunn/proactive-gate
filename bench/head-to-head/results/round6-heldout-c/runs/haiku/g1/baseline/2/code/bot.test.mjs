// Run with: node --test bot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSms } from './bot.mjs';

const chicago = (timezone = 'America/Chicago') => ({ id: 'u_123', phone: '+13125550142', timezone });

test('allowed mid-day in Chicago', () => {
  const r = checkSms(chicago(), new Date('2026-10-23T17:00:00Z')); // 12:00 CDT
  assert.equal(r.allowed, true);
  assert.equal(r.nextAllowedAt, null);
  assert.equal(typeof r.reason, 'string');
});

test('window opens exactly at 08:00 local, not a moment earlier', () => {
  const before = checkSms(chicago(), new Date('2026-10-23T12:59:59.999Z')); // 07:59:59.999 CDT
  assert.equal(before.allowed, false);
  assert.equal(before.nextAllowedAt.toISOString(), '2026-10-23T13:00:00.000Z');

  const at = checkSms(chicago(), new Date('2026-10-23T13:00:00.000Z')); // 08:00:00.000 CDT
  assert.equal(at.allowed, true);
});

test('window closes at 21:00 local and reopens next morning', () => {
  const late = checkSms(chicago(), new Date('2026-10-24T01:59:59.999Z')); // 20:59:59.999 CDT
  assert.equal(late.allowed, true);

  const closed = checkSms(chicago(), new Date('2026-10-24T02:00:00.000Z')); // 21:00 CDT
  assert.equal(closed.allowed, false);
  assert.equal(closed.nextAllowedAt.toISOString(), '2026-10-24T13:00:00.000Z'); // 08:00 CDT next day
});

test('standard time (CST) offset is used in winter', () => {
  const r = checkSms(chicago(), new Date('2026-01-15T11:00:00Z')); // 05:00 CST
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-01-15T14:00:00.000Z'); // 08:00 CST
});

test('held across the US DST change (2026-11-01, CDT ends at 02:00)', () => {
  const r = checkSms(chicago(), new Date('2026-11-01T05:30:00Z')); // 00:30 CDT
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-11-01T14:00:00.000Z'); // 08:00 CST
});

test('half-hour zone: India (UTC+05:30)', () => {
  const kolkata = chicago('Asia/Kolkata');
  const early = checkSms(kolkata, new Date('2026-10-23T02:00:00Z')); // 07:30 IST
  assert.equal(early.allowed, false);
  assert.equal(early.nextAllowedAt.toISOString(), '2026-10-23T02:30:00.000Z'); // 08:00 IST

  const night = checkSms(kolkata, new Date('2026-10-23T15:30:00Z')); // 21:00 IST
  assert.equal(night.allowed, false);
  assert.equal(night.nextAllowedAt.toISOString(), '2026-10-24T02:30:00.000Z');
});

test('half-hour zone with DST: Australia/Adelaide (+10:30 in October)', () => {
  const r = checkSms(chicago('Australia/Adelaide'), new Date('2026-10-22T20:30:00Z')); // 07:00 ACDT
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-22T21:30:00.000Z'); // 08:00 ACDT
});

test('nextAllowedAt is always a future instant when held', () => {
  const now = new Date('2026-10-23T09:00:00Z');
  for (const tz of ['Europe/London', 'Asia/Tokyo', 'Pacific/Chatham', 'America/Anchorage']) {
    const r = checkSms(chicago(tz), now);
    if (!r.allowed) assert.ok(r.nextAllowedAt.getTime() > now.getTime(), tz);
  }
});

test('missing, null, empty or unknown time zone is held with null retry time', () => {
  const now = new Date('2026-10-23T17:00:00Z');
  for (const timezone of [null, undefined, '', '   ', 'Mars/Olympus', 'Chicago']) {
    const r = checkSms({ id: 'u', phone: '+13125550142', timezone }, now);
    assert.equal(r.allowed, false, String(timezone));
    assert.equal(r.nextAllowedAt, null, String(timezone));
    assert.match(r.reason, /time zone/);
  }
});

test('malformed phone is held with null retry time', () => {
  const now = new Date('2026-10-23T17:00:00Z');
  for (const phone of ['3125550142', '+0123', '', null, 42]) {
    const r = checkSms({ id: 'u', phone, timezone: 'America/Chicago' }, now);
    assert.equal(r.allowed, false, String(phone));
    assert.equal(r.nextAllowedAt, null);
  }
});

test('result does not depend on the machine time zone', () => {
  const r = checkSms(chicago(), new Date('2026-10-23T12:59:59.999Z'));
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T13:00:00.000Z');
});

test('invalid arguments throw', () => {
  assert.throws(() => checkSms(chicago(), new Date('nope')), TypeError);
  assert.throws(() => checkSms(chicago(), '2026-10-23'), TypeError);
  assert.throws(() => checkSms(null, new Date()), TypeError);
});
