// Decides whether one outbound US SMS may be sent right now.
// Pure function: no I/O and no sending. The server's own time zone is never
// read; local time is always computed in the customer's IANA zone.
//
// Rules applied (see README-style notes in the reply to the user):
//   - Marketing texts: STOP honored, prior express written consent (47 CFR
//     64.1200(a)(2), recorded as marketingConsent), opt-out wording (CTIA),
//     and 8:00-21:00 recipient local time (47 CFR 64.1200(c)(1)).
//   - Transactional texts: not restricted by consent or time of day.
//     Requested by the customer's own action (TCPA exempts these from
//     marketing consent rules); body and recipient must still be valid.
//   - Malformed input fails closed with its own reason code.

const PHONE_RE = /^\+1[2-9]\d{2}[2-9]\d{6}$/; // NANP: +1, area code and exchange start 2-9
const MARKETING_START_HOUR = 8; // 08:00 local, inclusive
const MARKETING_END_HOUR = 21; // 21:00 local, exclusive

const allow = () => ({ allowed: true, reason: null });
const block = (reason) => ({ allowed: false, reason });

// Hour (0-23) of `now` in the given zone. Throws if the zone is missing or unknown.
function localHour(now, timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') {
    throw new RangeError('timeZone is required');
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
  });
  const hourPart = fmt.formatToParts(now).find((p) => p.type === 'hour');
  return Number(hourPart.value);
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return block('invalid_now');
  }
  if (!message || typeof message !== 'object') {
    return block('invalid_message');
  }

  const { kind, body, to } = message;
  if (kind !== 'marketing' && kind !== 'transactional') {
    return block('invalid_message');
  }
  if (typeof body !== 'string' || body.trim() === '') {
    return block('empty_body');
  }
  if (!to || typeof to !== 'object') {
    return block('invalid_recipient');
  }
  if (typeof to.phone !== 'string' || !PHONE_RE.test(to.phone)) {
    return block('invalid_phone');
  }
  // null = never opted out. A string must parse as a date; anything else is
  // unknown opt-out state, so we refuse rather than guess.
  if (
    to.optedOutAt !== null &&
    (typeof to.optedOutAt !== 'string' || Number.isNaN(Date.parse(to.optedOutAt)))
  ) {
    return block('invalid_opt_out_record');
  }

  if (kind === 'transactional') {
    return allow();
  }

  // Marketing from here on. Order matters only for which code is reported
  // when several rules fail: STOP is checked first because it is the
  // customer's most direct instruction.
  if (to.optedOutAt !== null) {
    return block('opted_out');
  }
  if (to.marketingConsent !== true) {
    return block('no_marketing_consent');
  }
  // CTIA: marketing messages must tell the recipient how to opt out.
  if (!/\bSTOP\b/i.test(body)) {
    return block('missing_opt_out_language');
  }
  let hour;
  try {
    hour = localHour(now, to.timeZone);
  } catch {
    return block('invalid_time_zone');
  }
  if (hour < MARKETING_START_HOUR || hour >= MARKETING_END_HOUR) {
    return block('outside_marketing_hours');
  }
  return allow();
}
