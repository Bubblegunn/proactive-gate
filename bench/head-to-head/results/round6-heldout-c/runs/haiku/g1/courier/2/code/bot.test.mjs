import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSms } from './bot.mjs';

const chicago = { id: 'u_1', phone: '+13125550142', timezone: 'America/Chicago' };
const at = (iso) => new Date(iso);

test('allowed inside the window, nextAllowedAt is null', () => {
  // 13:00 CDT (UTC-5 in late October)
  const r = checkSms(chicago, at('2026-10-23T18:00:00Z'));
  assert.equal(r.allowed, true);
  assert.equal(r.nextAllowedAt, null);
  assert.equal(typeof r.reason, 'string');
});

test('08:00 local is the first allowed moment, 07:59:59 is held', () => {
  assert.equal(checkSms(chicago, at('2026-10-23T13:00:00Z')).allowed, true);
  const early = checkSms(chicago, at('2026-10-23T12:59:59Z'));
  assert.equal(early.allowed, false);
  assert.equal(early.nextAllowedAt.toISOString(), '2026-10-23T13:00:00.000Z');
});

test('before 08:00 local: retry at 08:00 the same local day', () => {
  // 06:30 CDT
  const now = at('2026-10-23T11:30:00Z');
  const r = checkSms(chicago, now);
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T13:00:00.000Z');
  assert.match(r.reason, /06:30/);
});

test('20:59:59 local is allowed, 21:00 local is held until 08:00 next day', () => {
  assert.equal(checkSms(chicago, at('2026-10-24T01:59:59Z')).allowed, true);
  const late = checkSms(chicago, at('2026-10-24T02:00:00Z'));
  assert.equal(late.allowed, false);
  assert.equal(late.nextAllowedAt.toISOString(), '2026-10-24T13:00:00.000Z');
});

test('late evening across month end rolls to the next month', () => {
  const tz = { timezone: 'America/Chicago' };
  // 2026-10-31 22:00 CDT = 2026-11-01 03:00Z
  const r = checkSms(tz, at('2026-11-01T03:00:00Z'));
  assert.equal(r.allowed, false);
  // US clocks fall back on Sun Nov 1 2026 at 02:00, so 08:00 that day is CST (UTC-6) = 14:00Z
  assert.equal(r.nextAllowedAt.toISOString(), '2026-11-01T14:00:00.000Z');
});

test('half-hour zone (Asia/Kolkata, UTC+5:30)', () => {
  const user = { timezone: 'Asia/Kolkata' };
  // 07:50 IST = 02:20Z
  const r = checkSms(user, at('2026-10-23T02:20:00Z'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T02:30:00.000Z');
  assert.equal(checkSms(user, r.nextAllowedAt).allowed, true);
  assert.equal(checkSms(user, new Date(r.nextAllowedAt - 1)).allowed, false);
});

test('DST spring-forward day uses the real offset, not a fixed one', () => {
  // New York springs forward 2026-03-08 at 02:00 EST. 07:30 EDT = 11:30Z.
  const ny = { timezone: 'America/New_York' };
  const r = checkSms(ny, at('2026-03-08T11:30:00Z'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-03-08T12:00:00.000Z');
});

test('the machine time zone does not matter', () => {
  const user = { timezone: 'Pacific/Honolulu' };
  // 2026-10-23 06:00Z = 20:00 HST (UTC-10), allowed; 2026-10-23 18:00Z = 08:00 HST, allowed.
  assert.equal(checkSms(user, at('2026-10-23T06:00:00Z')).allowed, true);
  const r = checkSms(user, at('2026-10-23T17:00:00Z')); // 07:00 HST
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T18:00:00.000Z');
});

test('missing timezone is held with no retry time', () => {
  for (const tz of [null, undefined, '', 'Mars/Olympus', 'not a zone', 42]) {
    const r = checkSms({ id: 'u', phone: '+1', timezone: tz }, at('2026-10-23T18:00:00Z'));
    assert.equal(r.allowed, false, `timezone ${String(tz)}`);
    assert.equal(r.nextAllowedAt, null, `timezone ${String(tz)}`);
    assert.match(r.reason, /no valid time zone/);
  }
});

test('invalid now is held', () => {
  const r = checkSms(chicago, new Date('nope'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt, null);
});

test('reason strings are sentences a support person can read', () => {
  const r = checkSms(chicago, at('2026-10-23T11:30:00Z'));
  assert.equal(
    r.reason,
    'Held: it is 06:30 in America/Chicago; reminders go out only from 08:00 to 21:00 local time.',
  );
});
