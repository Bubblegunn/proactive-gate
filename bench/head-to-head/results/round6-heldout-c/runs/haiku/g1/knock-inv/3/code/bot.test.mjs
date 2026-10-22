import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSms } from './bot.mjs';

const chicago = { id: 'u_1', phone: '+13125550142', timezone: 'America/Chicago' };
const at = (iso) => new Date(iso);

test('allowed inside the window, nextAllowedAt is null', () => {
  // 10:00 CDT (UTC-5)
  const r = checkSms(chicago, at('2026-10-23T15:00:00Z'));
  assert.equal(r.allowed, true);
  assert.equal(r.nextAllowedAt, null);
  assert.equal(typeof r.reason, 'string');
});

test('08:00 local is allowed, 07:59:59 local is held until 08:00', () => {
  assert.equal(checkSms(chicago, at('2026-10-23T13:00:00Z')).allowed, true); // 08:00 CDT
  const early = checkSms(chicago, at('2026-10-23T12:59:59Z')); // 07:59:59 CDT
  assert.equal(early.allowed, false);
  assert.equal(early.nextAllowedAt.toISOString(), '2026-10-23T13:00:00.000Z');
});

test('20:59:59 local is allowed, 21:00 local is held until next day 08:00', () => {
  assert.equal(checkSms(chicago, at('2026-10-24T01:59:59Z')).allowed, true); // 20:59:59 CDT
  const late = checkSms(chicago, at('2026-10-24T02:00:00Z')); // 21:00 CDT
  assert.equal(late.allowed, false);
  assert.equal(late.nextAllowedAt.toISOString(), '2026-10-24T13:00:00.000Z');
  assert.match(late.reason, /21:00|Chicago/);
});

test('half-hour offset zone: Asia/Kolkata (UTC+5:30)', () => {
  const r = checkSms({ phone: '+13125550142', timezone: 'Asia/Kolkata' }, at('2026-10-23T02:29:00Z')); // 07:59 IST
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T02:30:00.000Z');
  assert.equal(checkSms({ phone: '+13125550142', timezone: 'Asia/Kolkata' }, at('2026-10-23T02:30:00Z')).allowed, true);
});

test('45-minute offset zone: Asia/Kathmandu (UTC+5:45)', () => {
  const r = checkSms({ phone: '+13125550142', timezone: 'Asia/Kathmandu' }, at('2026-10-23T16:30:00Z')); // 22:15 NPT
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-24T02:15:00.000Z'); // 08:00 NPT next day
});

test('Pacific/Honolulu (no DST) evening hold', () => {
  const r = checkSms({ phone: '+18085550100', timezone: 'Pacific/Honolulu' }, at('2026-10-23T07:30:00Z')); // 21:30 HST
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T18:00:00.000Z'); // 08:00 HST on Oct 23
});

test('spring-forward DST day: New York 08:00 EDT is 12:00Z', () => {
  const ny = { phone: '+12125550100', timezone: 'America/New_York' };
  const r = checkSms(ny, at('2026-03-08T02:30:00Z')); // 21:30 EST on Mar 7
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-03-08T12:00:00.000Z');
});

test('fall-back DST day: New York 08:00 EST is 13:00Z', () => {
  const ny = { phone: '+12125550100', timezone: 'America/New_York' };
  const r = checkSms(ny, at('2026-11-01T01:30:00Z')); // 21:30 EDT on Oct 31
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-11-01T13:00:00.000Z');
});

test('missing, empty, or unknown time zone is held with null nextAllowedAt', () => {
  const now = at('2026-10-23T15:00:00Z'); // 10:00 in Chicago, but the zone is unknown
  for (const timezone of [null, undefined, '', 'Mars/Olympus', 'CST', '+05:00', 42]) {
    const r = checkSms({ phone: '+13125550142', timezone }, now);
    assert.equal(r.allowed, false, `timezone ${JSON.stringify(timezone)} should be held`);
    assert.equal(r.nextAllowedAt, null);
  }
});

test('malformed phone is held with null nextAllowedAt', () => {
  for (const phone of [undefined, '', '3125550142', '+0123456', 'abc']) {
    const r = checkSms({ phone, timezone: 'America/Chicago' }, at('2026-10-23T15:00:00Z'));
    assert.equal(r.allowed, false);
    assert.equal(r.nextAllowedAt, null);
  }
});

test('invalid inputs throw', () => {
  assert.throws(() => checkSms(null, new Date()), TypeError);
  assert.throws(() => checkSms(chicago, '2026-10-23'), TypeError);
  assert.throws(() => checkSms(chicago, new Date('nope')), TypeError);
});

test('nextAllowedAt is exact: allowed at that instant, held one second before', () => {
  const zones = ['America/Chicago', 'Asia/Kolkata', 'Asia/Kathmandu', 'Pacific/Honolulu', 'America/New_York', 'Australia/Lord_Howe', 'Europe/London'];
  const start = Date.UTC(2026, 2, 6); // spans both DST changes in March and November 2026
  const end = Date.UTC(2026, 11, 1);
  for (const timezone of zones) {
    const user = { phone: '+13125550142', timezone };
    for (let t = start; t < end; t += 47 * 60 * 1000) { // step of 47 min walks through all phases of the day
      const now = new Date(t);
      const r = checkSms(user, now);
      if (r.allowed) continue;
      assert.ok(r.nextAllowedAt instanceof Date, `${timezone} at ${now.toISOString()} should have nextAllowedAt`);
      assert.ok(r.nextAllowedAt > now, `${timezone}: nextAllowedAt must be in the future`);
      assert.equal(checkSms(user, r.nextAllowedAt).allowed, true, `${timezone}: must be allowed at nextAllowedAt`);
      const justBefore = new Date(r.nextAllowedAt.getTime() - 1000);
      assert.equal(checkSms(user, justBefore).allowed, false, `${timezone}: must still be held 1s before nextAllowedAt`);
    }
  }
});
