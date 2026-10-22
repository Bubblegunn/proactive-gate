// Run with: node --test bot.test.mjs   (run under different TZ values to prove machine time zone is ignored)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSms } from './bot.mjs';

const chicago = { id: 'u_1', phone: '+13125550142', timezone: 'America/Chicago' };
const at = (iso) => new Date(iso);

test('allowed inside the window, inclusive start, exclusive end (Chicago, CDT = UTC-5)', () => {
  assert.equal(checkSms(chicago, at('2026-10-23T15:15:00Z')).allowed, true); // 10:15 local
  assert.equal(checkSms(chicago, at('2026-10-23T13:00:00Z')).allowed, true); // 08:00:00 local
  assert.equal(checkSms(chicago, at('2026-10-24T01:59:59.999Z')).allowed, true); // 20:59:59.999 local
  const ok = checkSms(chicago, at('2026-10-23T15:15:00Z'));
  assert.equal(ok.nextAllowedAt, null);
  assert.equal(typeof ok.reason, 'string');
});

test('blocked just before 08:00 local; next allowed is 08:00 the same day', () => {
  const r = checkSms(chicago, at('2026-10-23T12:59:59.999Z')); // 07:59:59.999 local
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T13:00:00.000Z');
});

test('blocked at 21:00 local; next allowed is 08:00 the next day', () => {
  const r = checkSms(chicago, at('2026-10-24T02:00:00Z')); // 21:00 CDT on Oct 23
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-24T13:00:00.000Z');
});

test('half-hour offset zone (Asia/Kolkata, UTC+05:30)', () => {
  const user = { id: 'u_2', phone: '+919876543210', timezone: 'Asia/Kolkata' };
  const r = checkSms(user, at('2026-10-22T21:00:00Z')); // 02:30 IST
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T02:30:00.000Z'); // 08:00 IST
});

test('half-hour DST zone (Australia/Adelaide, UTC+10:30 in October)', () => {
  const user = { id: 'u_3', phone: '+61412345678', timezone: 'Australia/Adelaide' };
  const r = checkSms(user, at('2026-10-23T11:00:00Z')); // 21:30 local
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T21:30:00.000Z'); // 08:00 local on Oct 24
});

test('spring-forward DST (America/New_York, 2026-03-08)', () => {
  const user = { id: 'u_4', phone: '+12125550100', timezone: 'America/New_York' };
  const r = checkSms(user, at('2026-03-08T04:30:00Z')); // 23:30 EST on Mar 7
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-03-08T12:00:00.000Z'); // 08:00 EDT on Mar 8
});

test('fall-back DST (America/New_York, 2026-11-01)', () => {
  const user = { id: 'u_5', phone: '+12125550100', timezone: 'America/New_York' };
  const r = checkSms(user, at('2026-11-02T02:00:00Z')); // 22:00 EDT on Nov 1
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-11-02T13:00:00.000Z'); // 08:00 EST on Nov 2
});

test('month rollover at end of month (Europe/London, 2026-10-31 night)', () => {
  const user = { id: 'u_6', phone: '+442071838750', timezone: 'Europe/London' };
  const r = checkSms(user, at('2026-10-31T23:30:00Z')); // 23:30 GMT on Oct 31
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-11-01T08:00:00.000Z');
});

test('missing or unrecognised time zone is held with no retry time', () => {
  const now = at('2026-10-23T15:15:00Z');
  for (const timezone of [null, undefined, '', 'Mars/Olympus', 'Chicago']) {
    const r = checkSms({ ...chicago, timezone }, now);
    assert.equal(r.allowed, false, `timezone ${JSON.stringify(timezone)}`);
    assert.equal(r.nextAllowedAt, null, `timezone ${JSON.stringify(timezone)}`);
    assert.match(r.reason, /time zone|local time/);
  }
});

test('missing or malformed phone is held with no retry time', () => {
  const now = at('2026-10-23T15:15:00Z');
  for (const phone of [undefined, '', '3125550142', '+0123456789', '+1 312 555 0142', 'abc']) {
    const r = checkSms({ ...chicago, phone }, now);
    assert.equal(r.allowed, false, `phone ${JSON.stringify(phone)}`);
    assert.equal(r.nextAllowedAt, null, `phone ${JSON.stringify(phone)}`);
  }
});

test('invalid now throws', () => {
  assert.throws(() => checkSms(chicago, new Date('nope')), TypeError);
  assert.throws(() => checkSms(chicago, '2026-10-23T15:15:00Z'), TypeError);
});

test('nextAllowedAt is exact: allowed at it, blocked 1 ms before, across zones and a full year', () => {
  const zones = [
    'America/Chicago', 'America/New_York', 'America/Los_Angeles', 'America/Anchorage',
    'Pacific/Honolulu', 'Asia/Kolkata', 'Australia/Adelaide', 'Asia/Kathmandu', 'Europe/London',
  ];
  const start = Date.UTC(2026, 0, 1);
  const end = Date.UTC(2027, 0, 1);
  let blockedCount = 0;
  for (const timezone of zones) {
    const user = { id: 'sweep', phone: '+13125550142', timezone };
    for (let t = start; t < end; t += 30 * 60 * 1000) {
      const now = new Date(t + 7 * 60 * 1000); // offset from the grid so local times vary
      const r = checkSms(user, now);
      if (r.allowed) {
        assert.equal(r.nextAllowedAt, null);
        continue;
      }
      blockedCount++;
      assert.ok(r.nextAllowedAt instanceof Date, `${timezone} ${now.toISOString()}`);
      assert.ok(r.nextAllowedAt > now, `${timezone} ${now.toISOString()} next must be later`);
      assert.equal(checkSms(user, r.nextAllowedAt).allowed, true, `${timezone} at next ${r.nextAllowedAt.toISOString()}`);
      assert.equal(
        checkSms(user, new Date(r.nextAllowedAt.getTime() - 1)).allowed,
        false,
        `${timezone} 1ms before next ${r.nextAllowedAt.toISOString()} must still be blocked`,
      );
    }
  }
  assert.ok(blockedCount > 0);
});
