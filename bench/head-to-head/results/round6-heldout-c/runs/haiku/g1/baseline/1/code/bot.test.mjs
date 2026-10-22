import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSms } from './bot.mjs';

const chicago = { id: 'u_1', phone: '+13125550142', timezone: 'America/Chicago' };
const at = (iso) => new Date(iso);

test('allowed inside the window, nextAllowedAt is null', () => {
  // 2026-10-23 15:00Z is 10:00 CDT (UTC-5)
  const r = checkSms(chicago, at('2026-10-23T15:00:00Z'));
  assert.equal(r.allowed, true);
  assert.equal(r.nextAllowedAt, null);
  assert.equal(typeof r.reason, 'string');
});

test('window start 09:00 local is allowed, 08:59:59 is held until 09:00 local', () => {
  assert.equal(checkSms(chicago, at('2026-10-23T14:00:00Z')).allowed, true); // 09:00 CDT
  const early = checkSms(chicago, at('2026-10-23T13:59:59Z')); // 08:59:59 CDT
  assert.equal(early.allowed, false);
  assert.equal(early.nextAllowedAt.toISOString(), '2026-10-23T14:00:00.000Z');
});

test('20:00 local is held until 09:00 the next local day', () => {
  // 2026-10-24 01:00Z is 20:00 CDT on 10-23
  const r = checkSms(chicago, at('2026-10-24T01:00:00Z'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-24T14:00:00.000Z');
  // 19:59:59.999 local is still allowed
  assert.equal(checkSms(chicago, at('2026-10-24T00:59:59.999Z')).allowed, true);
});

test('late evening crossing into the next month', () => {
  const tz = { phone: '+13125550142', timezone: 'America/Chicago' };
  // 2026-11-01 03:00Z is 22:00 CDT on 10-31. US DST ends at 02:00 CDT on 11-01, so 09:00 on 11-01 is CST (UTC-6) = 15:00Z
  const r = checkSms(tz, at('2026-11-01T03:00:00Z'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-11-01T15:00:00.000Z');
});

test('half-hour offset zone (Asia/Kolkata, UTC+05:30)', () => {
  const user = { phone: '+919876543210', timezone: 'Asia/Kolkata' };
  // 02:00Z is 07:30 IST -> held until 09:00 IST = 03:30Z
  const r = checkSms(user, at('2026-10-23T02:00:00Z'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-23T03:30:00.000Z');
  assert.equal(checkSms(user, at('2026-10-23T03:30:00Z')).allowed, true);
});

test('45-minute offset zone (Asia/Kathmandu, UTC+05:45)', () => {
  const user = { phone: '+9779841234567', timezone: 'Asia/Kathmandu' };
  // 20:00Z is 01:45 NPT next day -> held until 09:00 NPT = 03:15Z
  const r = checkSms(user, at('2026-10-23T20:00:00Z'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-10-24T03:15:00.000Z');
});

test('DST: spring forward (America/New_York, 2026-03-08)', () => {
  const user = { phone: '+12125550100', timezone: 'America/New_York' };
  // 2026-03-08 02:00Z is 21:00 EST on 03-07 -> next 09:00 on 03-08 is EDT (UTC-4) = 13:00Z
  const r = checkSms(user, at('2026-03-08T02:00:00Z'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-03-08T13:00:00.000Z');
});

test('DST: fall back (America/New_York, 2026-11-01)', () => {
  const user = { phone: '+12125550100', timezone: 'America/New_York' };
  // 2026-11-02 02:00Z is 21:00 EDT on 11-01 -> next 09:00 on 11-02 is EST (UTC-5) = 14:00Z
  const r = checkSms(user, at('2026-11-02T02:00:00Z'));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), '2026-11-02T14:00:00.000Z');
});

test('missing or invalid time zone is held with null nextAllowedAt', () => {
  for (const timezone of [null, undefined, '', 'Mars/Olympus', 'EST5EDT_nope', '+03:00', 42]) {
    const r = checkSms({ phone: '+13125550142', timezone }, at('2026-10-23T15:00:00Z'));
    assert.equal(r.allowed, false, `timezone ${JSON.stringify(timezone)}`);
    assert.equal(r.nextAllowedAt, null);
    assert.equal(typeof r.reason, 'string');
  }
});

test('invalid phone is held with null nextAllowedAt', () => {
  for (const phone of [undefined, '', '3125550142', '+0123', '+1 312 555 0142', 'abc']) {
    const r = checkSms({ phone, timezone: 'America/Chicago' }, at('2026-10-23T15:00:00Z'));
    assert.equal(r.allowed, false, `phone ${JSON.stringify(phone)}`);
    assert.equal(r.nextAllowedAt, null);
  }
});

test('invalid now throws', () => {
  assert.throws(() => checkSms(chicago, new Date('nope')), TypeError);
  assert.throws(() => checkSms(chicago, '2026-10-23T15:00:00Z'), TypeError);
});

test('nextAllowedAt is exact: allowed at it, held one millisecond before (many zones and instants)', () => {
  const zones = ['America/Chicago', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
    'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'Europe/London', 'America/St_Johns', 'UTC'];
  const user = (timezone) => ({ phone: '+13125550142', timezone });
  let checked = 0;
  for (const zone of zones) {
    for (let h = 0; h < 24 * 14; h += 7) {
      const now = new Date(Date.UTC(2026, 2, 1, 0, 0, 0) + h * 3600_000 + 17_000);
      const r = checkSms(user(zone), now);
      if (r.allowed) continue;
      assert.ok(r.nextAllowedAt instanceof Date, `${zone} ${now.toISOString()}`);
      assert.ok(r.nextAllowedAt > now, `${zone} ${now.toISOString()}`);
      assert.equal(checkSms(user(zone), r.nextAllowedAt).allowed, true, `${zone} at ${r.nextAllowedAt.toISOString()}`);
      const justBefore = new Date(r.nextAllowedAt.getTime() - 1);
      assert.equal(checkSms(user(zone), justBefore).allowed, false, `${zone} before ${r.nextAllowedAt.toISOString()}`);
      checked++;
    }
  }
  assert.ok(checked > 100, `only ${checked} held cases checked`);
});

test('does not depend on the machine time zone', () => {
  const prev = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Kiritimati';
    const a = checkSms(chicago, at('2026-10-23T15:00:00Z'));
    process.env.TZ = 'Pacific/Pago_Pago';
    const b = checkSms(chicago, at('2026-10-23T15:00:00Z'));
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, true);
    assert.equal(checkSms(chicago, at('2026-10-23T13:00:00Z')).nextAllowedAt.toISOString(), '2026-10-23T14:00:00.000Z');
  } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
});
