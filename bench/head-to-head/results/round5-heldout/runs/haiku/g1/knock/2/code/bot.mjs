// Pre-send compliance gate for US SMS.
//
// checkSms(message, now) decides whether one text may go to the SMS provider
// right now. It sends nothing. It returns { allowed, reason }: reason is the
// snake_case code of the first rule that blocked the text, or null.
//
// Rules, in the order they are checked:
//   1. Structural input checks (kind, body, phone, time zone, now, opt-out
//      timestamp). Any failure blocks, so bad data never reaches the provider.
//   2. Opt-out: the customer replied STOP. Blocks both kinds.
//      (47 CFR 64.1200(a)(10) revocation of consent; CTIA: STOP ends the program.)
//   3. Marketing only: prior express written consent (47 CFR 64.1200(a)(2)).
//   4. Marketing only: quiet hours, 8:00 a.m. to 9:00 p.m. in the customer's
//      local time (47 CFR 64.1200(c)(1)). The FCC applies this to texts too.
//   5. Marketing only: the body must tell the customer how to opt out
//      (CTIA Messaging Principles and Best Practices: "Reply STOP to opt out").
//
// Transactional texts are not subject to rules 3-5. The customer caused them
// by using the app, which gives the consent that the TCPA requires for
// autodialed texts to a cell phone.
//
// The function reads only its inputs. It does not use the server clock or the
// server time zone: `now` is an instant and every local-time check uses the
// customer's IANA time zone.

const KINDS = new Set(['marketing', 'transactional']);

// US (NANP) E.164 number: +1, then area code and exchange that each start with 2-9.
const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

// Quiet hours in minutes after local midnight. Telemarketing is allowed from
// 08:00 (480) up to, but not including, 21:00 (1260). "After 9 p.m." is read
// as 21:00:00 itself being blocked, the conservative reading.
const QUIET_START_MIN = 8 * 60;
const QUIET_END_MIN = 21 * 60;

// Matches STOP as a whole word, any case.
const OPT_OUT_WORD = /\bSTOP\b/i;

function block(reason) {
  return { allowed: false, reason };
}

function isValidTimeZone(zone) {
  if (typeof zone !== 'string' || zone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Local minutes after midnight for the instant `now` in the zone `timeZone`.
function localMinutesOfDay(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return hour * 60 + minute;
}

export function checkSms(message, now) {
  if (message === null || typeof message !== 'object') {
    return block('invalid_message');
  }
  const { kind, body, to } = message;

  if (!KINDS.has(kind)) {
    return block('invalid_kind');
  }
  if (typeof body !== 'string' || body.trim().length === 0) {
    return block('empty_body');
  }
  if (to === null || typeof to !== 'object') {
    return block('invalid_recipient');
  }
  if (typeof to.phone !== 'string' || !US_E164.test(to.phone)) {
    return block('invalid_phone');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return block('invalid_now');
  }

  // Opt-out check. A STOP is final for this sender, so any recorded opt-out
  // blocks. A value we cannot parse also blocks (fail closed).
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    const optedOut = new Date(to.optedOutAt);
    if (typeof to.optedOutAt !== 'string' || Number.isNaN(optedOut.getTime())) {
      return block('invalid_opt_out_timestamp');
    }
    return block('opted_out');
  }

  if (kind === 'transactional') {
    return { allowed: true, reason: null };
  }

  // From here on, marketing rules only.
  if (to.marketingConsent !== true) {
    return block('no_marketing_consent');
  }
  if (!isValidTimeZone(to.timeZone)) {
    return block('invalid_time_zone');
  }
  const minutes = localMinutesOfDay(now, to.timeZone);
  if (minutes < QUIET_START_MIN || minutes >= QUIET_END_MIN) {
    return block('outside_quiet_hours');
  }
  if (!OPT_OUT_WORD.test(body)) {
    return block('missing_opt_out_instructions');
  }

  return { allowed: true, reason: null };
}
