import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSms } from './bot.mjs';

const OPT_OUT_BODY = 'Flash sale: 20% off today. Reply STOP to opt out.';

function marketing(overrides = {}) {
  return {
    kind: 'marketing',
    body: OPT_OUT_BODY,
    to: {
      phone: '+13125550142',
      timeZone: 'America/Chicago',
      marketingConsent: true,
      optedOutAt: null,
      ...overrides,
    },
  };
}

function transactional(overrides = {}) {
  return {
    kind: 'transactional',
    body: 'Your login code is 428113.',
    to: {
      phone: '+13125550142',
      timeZone: 'America/Chicago',
      marketingConsent: false,
      optedOutAt: null,
      ...overrides,
    },
  };
}

// Chicago is UTC-5 (CDT) on 2026-10-22, so local 08:00 is 13:00Z.
const chicago = (utcIso) => new Date(utcIso);

test('marketing is allowed inside the window with consent and STOP', () => {
  assert.deepEqual(checkSms(marketing(), chicago('2026-10-22T15:00:00Z')), {
    allowed: true,
    reason: null,
  });
});

test('quiet hours in the recipient zone: 07:59 blocked, 08:00 allowed', () => {
  assert.equal(checkSms(marketing(), chicago('2026-10-22T12:59:00Z')).reason, 'outside_marketing_hours');
  assert.equal(checkSms(marketing(), chicago('2026-10-22T13:00:00Z')).allowed, true);
});

test('quiet hours end: 20:59 allowed, 21:00 blocked', () => {
  // 20:59 CDT = 01:59Z next day; 21:00 CDT = 02:00Z next day.
  assert.equal(checkSms(marketing(), chicago('2026-10-23T01:59:00Z')).allowed, true);
  assert.equal(checkSms(marketing(), chicago('2026-10-23T02:00:00Z')).reason, 'outside_marketing_hours');
});

test('quiet hours follow the recipient zone, not UTC or the server zone', () => {
  // 03:00Z on 10-23 is 22:00 in Chicago (blocked) but 12:00 in Tokyo (allowed).
  const instant = chicago('2026-10-23T03:00:00Z');
  assert.equal(checkSms(marketing(), instant).reason, 'outside_marketing_hours');
  assert.equal(checkSms(marketing({ timeZone: 'Asia/Tokyo' }), instant).allowed, true);
});

test('server time zone does not change the answer', () => {
  const original = process.env.TZ;
  const instant = chicago('2026-10-22T15:00:00Z');
  try {
    for (const tz of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      assert.equal(checkSms(marketing(), instant).allowed, true, `server TZ=${tz}`);
      assert.equal(
        checkSms(marketing(), chicago('2026-10-22T12:59:00Z')).reason,
        'outside_marketing_hours',
        `server TZ=${tz}`,
      );
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('DST: 08:00 local on the spring-forward day is 13:00Z (CDT), not 14:00Z', () => {
  // 2026-03-08 is the US spring-forward date; Chicago is CDT (UTC-5) from 02:00 local.
  assert.equal(checkSms(marketing(), chicago('2026-03-08T13:00:00Z')).allowed, true);
  assert.equal(checkSms(marketing(), chicago('2026-03-08T12:59:00Z')).reason, 'outside_marketing_hours');
});

test('transactional ignores consent, quiet hours and STOP', () => {
  const late = chicago('2026-10-23T03:00:00Z'); // 22:00 Chicago
  assert.deepEqual(checkSms(transactional(), late), { allowed: true, reason: null });
  assert.deepEqual(
    checkSms(transactional({ optedOutAt: '2026-10-01T10:00:00Z' }), late),
    { allowed: true, reason: null },
  );
});

test('marketing without consent is blocked', () => {
  assert.equal(
    checkSms(marketing({ marketingConsent: false }), chicago('2026-10-22T15:00:00Z')).reason,
    'no_marketing_consent',
  );
  assert.equal(
    checkSms(marketing({ marketingConsent: undefined }), chicago('2026-10-22T15:00:00Z')).reason,
    'no_marketing_consent',
  );
});

test('marketing after STOP is blocked, even if STOP was recorded in the future', () => {
  assert.equal(
    checkSms(marketing({ optedOutAt: '2026-10-01T10:00:00Z' }), chicago('2026-10-22T15:00:00Z')).reason,
    'opted_out',
  );
  assert.equal(
    checkSms(marketing({ optedOutAt: '2026-12-01T10:00:00Z' }), chicago('2026-10-22T15:00:00Z')).reason,
    'opted_out',
  );
});

test('unparseable opt-out data fails closed', () => {
  assert.equal(
    checkSms(marketing({ optedOutAt: 'not a date' }), chicago('2026-10-22T15:00:00Z')).reason,
    'opt_out_status_unknown',
  );
});

test('marketing without the STOP keyword is blocked', () => {
  assert.equal(
    checkSms({ ...marketing(), body: 'Flash sale: 20% off today.' }, chicago('2026-10-22T15:00:00Z')).reason,
    'missing_opt_out_language',
  );
});

test('invalid time zone blocks marketing', () => {
  assert.equal(
    checkSms(marketing({ timeZone: 'Mars/Olympus' }), chicago('2026-10-22T15:00:00Z')).reason,
    'invalid_time_zone',
  );
  assert.equal(
    checkSms(marketing({ timeZone: '' }), chicago('2026-10-22T15:00:00Z')).reason,
    'invalid_time_zone',
  );
});

test('phone must be a US (+1) number', () => {
  const now = chicago('2026-10-22T15:00:00Z');
  for (const phone of ['3125550142', '+443001234567', '+10125550142', '+11125550142', '+1312555014', '']) {
    assert.equal(checkSms(transactional({ phone }), now).reason, 'invalid_us_phone', phone);
  }
});

test('empty body and unknown kind are blocked', () => {
  const now = chicago('2026-10-22T15:00:00Z');
  assert.equal(checkSms({ ...transactional(), body: '   ' }, now).reason, 'empty_body');
  assert.equal(checkSms({ ...transactional(), kind: 'promo' }, now).reason, 'invalid_kind');
});

test('invalid send time and malformed input are blocked', () => {
  assert.equal(checkSms(marketing(), new Date('nope')).reason, 'invalid_send_time');
  assert.equal(checkSms(marketing(), '2026-10-22T15:00:00Z').reason, 'invalid_send_time');
  assert.equal(checkSms(null, new Date()).reason, 'invalid_message');
  assert.equal(checkSms({ ...transactional(), to: null }, new Date()).reason, 'invalid_recipient');
});

test('each blocking rule has its own code', () => {
  const now = chicago('2026-10-22T12:00:00Z'); // 07:00 Chicago, outside hours
  const codes = [
    checkSms(marketing({ marketingConsent: false }), now).reason,
    checkSms(marketing({ optedOutAt: '2026-10-01T10:00:00Z' }), now).reason,
    checkSms(marketing({ optedOutAt: 'x' }), now).reason,
    checkSms(marketing({ timeZone: 'Mars/Olympus' }), now).reason,
    checkSms(marketing(), now).reason,
    checkSms({ ...marketing(), body: 'no keyword here' }, chicago('2026-10-22T15:00:00Z')).reason,
    checkSms(transactional({ phone: 'bad' }), now).reason,
    checkSms({ ...transactional(), body: '' }, now).reason,
    checkSms({ ...transactional(), kind: 'x' }, now).reason,
    checkSms(transactional(), new Date('nope')).reason,
  ];
  assert.equal(new Set(codes).size, codes.length, codes.join(', '));
  for (const code of codes) assert.match(code, /^[a-z]+(_[a-z]+)*$/);
});
