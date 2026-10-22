import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSms } from './bot.mjs';

const US_PHONE = '+13125550142';
const chicago = { id: 'u_1', phone: US_PHONE, timezone: 'America/Chicago' };
const at = (iso) => new Date(iso);

test('allowed inside the window in the patient zone', () => {
  const r = checkSms(chicago, at('2026-10-23T14:00:00Z')); // 09:00 CDT
  assert.equal(r.allowed, true);
  assert.equal(r.nextAllowedAt, null);
  assert.equal(typeof r.reason, 'string');
});

test('held before 08:00 local, reopens exactly at 08:00 local', () => {
  const now = at('2026-10-23T12:59:00Z'); // 07:59 CDT
  const r = checkSms(chicago, now);
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T13:00:00.000Z');
  assert.match(r.reason, /07:59/);
});

test('held at 21:00 local, reopens next morning at 08:00 local', () => {
  const r = checkSms(chicago, at('2026-10-24T02:00:00Z')); // 21:00 CDT on the 23rd
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-24T13:00:00.000Z');
});

test('20:59:59 local is still allowed; the window ends at 21:00', () => {
  assert.equal(checkSms(chicago, at('2026-10-24T01:59:59Z')).allowed, true);
});

test('half-hour offset zone (Asia/Kolkata, UTC+05:30)', () => {
  const user = { id: 'u_2', phone: '+919876543210', timezone: 'Asia/Kolkata' };
  const r = checkSms(user, at('2026-10-23T02:00:00Z')); // 07:30 IST
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T02:30:00.000Z');
  assert.equal(checkSms(user, at('2026-10-23T02:30:00Z')).allowed, true);
});

test('45-minute offset zone (Asia/Kathmandu, UTC+05:45)', () => {
  const user = { id: 'u_3', phone: '+9779800000000', timezone: 'Asia/Kathmandu' };
  const r = checkSms(user, at('2026-10-23T02:14:00Z')); // 07:59 NPT
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T02:15:00.000Z');
});

test('spring-forward day: New York 08:00 EDT starts at 12:00Z', () => {
  const ny = { id: 'u_4', phone: US_PHONE, timezone: 'America/New_York' };
  const held = checkSms(ny, at('2026-03-08T11:59:00Z')); // 07:59 EDT
  assert.equal(held.allowed, false);
  assert.equal(held.nextAllowedAt.toISOString(), '2026-03-08T12:00:00.000Z');
  assert.equal(checkSms(ny, at('2026-03-08T12:00:00Z')).allowed, true);
});

test('fall-back day: New York 08:00 EST starts at 13:00Z', () => {
  const ny = { id: 'u_5', phone: US_PHONE, timezone: 'America/New_York' };
  const held = checkSms(ny, at('2026-11-01T12:59:00Z')); // 07:59 EST
  assert.equal(held.allowed, false);
  assert.equal(held.nextAllowedAt.toISOString(), '2026-11-01T13:00:00.000Z');
});

test('unknown zone + US number: window must hold in every US zone', () => {
  const noZone = { id: 'u_6', phone: US_PHONE, timezone: null };
  // 17:59Z is 07:59 in Honolulu, so still held there.
  const held = checkSms(noZone, at('2026-10-23T17:59:00Z'));
  assert.equal(held.allowed, false);
  assert.equal(held.nextAllowedAt.toISOString(), '2026-10-23T18:00:00.000Z');
  // 18:00Z is 08:00 in Honolulu and inside the window in every other US zone.
  assert.equal(checkSms(noZone, at('2026-10-23T18:00:00Z')).allowed, true);
  // 01:00Z is 21:00 EDT, so the common window has closed.
  const late = checkSms(noZone, at('2026-10-23T01:00:00Z'));
  assert.equal(late.allowed, false);
  assert.equal(late.nextAllowedAt.toISOString(), '2026-10-23T18:00:00.000Z');
  assert.equal(checkSms(noZone, at('2026-10-23T00:59:00Z')).allowed, true);
});

test('unrecognised zone string behaves like no zone', () => {
  const bogus = { id: 'u_7', phone: US_PHONE, timezone: 'Mars/Olympus' };
  const r = checkSms(bogus, at('2026-10-23T17:59:00Z'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T18:00:00.000Z');
});

test('no zone and a non-US number: held, no retry time', () => {
  const uk = { id: 'u_8', phone: '+442079460000', timezone: null };
  const r = checkSms(uk, at('2026-10-23T14:00:00Z'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt, null);
  assert.match(r.reason, /not a US number/);
});

test('a valid zone is used even when the phone is not a US number', () => {
  const london = { id: 'u_9', phone: '+442079460000', timezone: 'Europe/London' };
  assert.equal(checkSms(london, at('2026-10-23T09:00:00Z')).allowed, true); // 10:00 BST
});

test('UTC zone is valid', () => {
  const user = { id: 'u_10', phone: US_PHONE, timezone: 'UTC' };
  assert.equal(checkSms(user, at('2026-10-23T07:59:00Z')).allowed, false);
  assert.equal(checkSms(user, at('2026-10-23T08:00:00Z')).allowed, true);
});

test('invalid now throws', () => {
  assert.throws(() => checkSms(chicago, new Date('nope')), TypeError);
  assert.throws(() => checkSms(chicago, '2026-10-23'), TypeError);
});

test('nextAllowedAt is not too early for a sweep of instants', () => {
  // For each held instant, the returned time must be allowed and the moment before must be held.
  const zones = [
    { id: 'a', phone: US_PHONE, timezone: 'America/Los_Angeles' },
    { id: 'b', phone: US_PHONE, timezone: 'Asia/Kathmandu' },
    { id: 'c', phone: US_PHONE, timezone: null },
  ];
  let checked = 0;
  for (const user of zones) {
    for (let m = 0; m < 3 * 24 * 60; m += 37) {
      const now = new Date(Date.UTC(2026, 9, 23, 0, 0) + m * 60000 + 17000);
      const r = checkSms(user, now);
      if (r.allowed || r.nextAllowedAt === null) continue;
      assert.equal(checkSms(user, r.nextAllowedAt).allowed, true, `${user.id} ${now.toISOString()}`);
      const justBefore = new Date(r.nextAllowedAt.getTime() - 1);
      assert.equal(checkSms(user, justBefore).allowed, false, `${user.id} ${justBefore.toISOString()}`);
      checked++;
    }
  }
  assert.ok(checked > 100);
});
