// US SMS send gate. Pure and synchronous: no I/O, no state, no reads of the
// server clock or server time zone. The only time input is `now`.
//
// Rules (47 CFR 64.1200 and CTIA Messaging Principles):
//   - Opt-out (STOP) blocks every message to the number, both kinds.
//   - Marketing needs prior express written consent (marketingConsent === true).
//   - Marketing must tell the customer how to opt out ("Reply STOP ...").
//   - Marketing is sent only 08:00 to 21:00 in the customer's home time zone.
//   - Transactional messages are sent when the customer triggered them, so
//     they skip the consent and time-window checks.

const PHONE_US = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const ZONE_NAME = /^[A-Za-z]+\/[A-Za-z_-]+(?:\/[A-Za-z_-]+)?$/;
const OPT_OUT_INSTRUCTIONS = /\b(?:reply|text)\s+STOP\b/i;
const WINDOW_START_MINUTE = 8 * 60; // 08:00 local, included
const WINDOW_END_MINUTE = 21 * 60; // 21:00 local, excluded

function block(reason) {
  return { allowed: false, reason };
}

function isValidZone(timeZone) {
  if (typeof timeZone !== 'string' || !ZONE_NAME.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function localMinuteOfDay(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const value = type => Number(parts.find(p => p.type === type).value);
  return value('hour') * 60 + value('minute');
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block('invalid_now');
  if (!message || typeof message !== 'object') return block('invalid_message');

  const { kind, body, to } = message;
  if (kind !== 'marketing' && kind !== 'transactional') return block('invalid_kind');
  if (typeof body !== 'string' || body.trim() === '') return block('empty_body');
  if (!to || typeof to !== 'object') return block('invalid_recipient');
  if (typeof to.phone !== 'string' || !PHONE_US.test(to.phone)) return block('invalid_phone');

  // null means no STOP on record. Any other value, including a malformed one,
  // means the customer opted out, so the gate fails closed.
  if (to.optedOutAt === undefined) return block('invalid_recipient');
  if (to.optedOutAt !== null) return block('opted_out');

  if (kind === 'transactional') return { allowed: true, reason: null };

  if (to.marketingConsent !== true) return block('no_marketing_consent');
  if (!OPT_OUT_INSTRUCTIONS.test(body)) return block('missing_opt_out_instructions');
  if (!isValidZone(to.timeZone)) return block('invalid_time_zone');

  const minute = localMinuteOfDay(now, to.timeZone);
  if (minute < WINDOW_START_MINUTE || minute >= WINDOW_END_MINUTE) {
    return block('outside_marketing_hours');
  }

  return { allowed: true, reason: null };
}
