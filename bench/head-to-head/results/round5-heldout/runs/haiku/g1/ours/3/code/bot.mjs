// US SMS send gate. Decides whether one text may go out now and which rule blocked it.
// Sends nothing. Pure function: no state, no I/O, no dependencies.
//
// Rules applied (see the notes at the bottom of this file for the mapping to 47 CFR 64.1200 and CTIA):
//   - Opt-out (STOP / revocation) blocks every text to that phone.
//   - Marketing needs the customer's marketing sign-up consent (prior express written consent).
//   - Marketing is sent only between 08:00 and 21:00 in the customer's home time zone.
//   - Transactional texts are triggered by the customer's own action; they need no consent check and no time window.

// 08:00 local, included. Minutes since local midnight.
const WINDOW_OPEN_MINUTE = 8 * 60;
// 21:00 local, excluded.
const WINDOW_CLOSE_MINUTE = 21 * 60;

// North American Numbering Plan: +1, area code and exchange start with 2-9.
const US_PHONE_RE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

const ALLOW = Object.freeze({ allowed: true, reason: null });

function deny(reason) {
  return { allowed: false, reason };
}

// Returns the wall-clock minutes since midnight of `date` in `timeZone`, or null if the zone is invalid.
// Uses hourCycle h23 so midnight is 0, not 24. The server's own zone never enters the calculation.
function localMinuteOfDay(date, timeZone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return hour * 60 + minute;
}

export function checkSms(message, now) {
  if (!message || typeof message !== 'object') return deny('invalid_message');

  const { kind, body, to } = message;

  if (kind !== 'marketing' && kind !== 'transactional') return deny('invalid_kind');

  if (!to || typeof to !== 'object') return deny('invalid_recipient');
  if (typeof to.phone !== 'string' || !US_PHONE_RE.test(to.phone)) return deny('invalid_phone_number');

  if (typeof body !== 'string' || body.trim() === '') return deny('empty_body');

  // The field is required. Absent means the data is broken, not that the customer opted out.
  if (to.optedOutAt === undefined) return deny('invalid_recipient');
  // Any STOP timestamp (valid or not) blocks. Unknown revocation status is treated as revoked.
  if (to.optedOutAt !== null) return deny('opted_out');

  // Transactional: customer-triggered, so no consent or time-of-day check.
  if (kind === 'transactional') return ALLOW;

  // Marketing from here on.
  if (to.marketingConsent !== true) return deny('no_marketing_consent');

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny('invalid_time');

  const minute = localMinuteOfDay(now, to.timeZone);
  if (minute === null) return deny('invalid_time_zone');

  if (minute < WINDOW_OPEN_MINUTE || minute >= WINDOW_CLOSE_MINUTE) return deny('quiet_hours');

  return ALLOW;
}

// Notes for compliance review (not enforced in code):
// - 47 CFR 64.1200(a)(2): autodialed or prerecorded marketing texts need prior express written consent.
//   Enforced as marketingConsent === true. Whether the sign-up form meets the "written" and disclosure
//   wording requirements is outside this function.
// - 47 CFR 64.1200(a)(10): revocation by any reasonable means must be honored. Enforced as optedOutAt !== null.
//   The 10-business-day processing window and the one-time confirmation text are process items, not checked here.
// - 47 CFR 64.1200(c)(1) and the 8am-9pm calling window for telemarketing, applied to marketing texts via the
//   customer's home time zone. Enforced as 08:00 <= local < 21:00.
// - 47 CFR 64.1200(c)(2) national Do-Not-Call list: not checked. This function receives no DNC data.
// - CTIA Messaging Principles and Best Practices: opt-out and consent handling are covered above. Sender
//   identification and the HELP/STOP keyword instructions in the message body are not checked.
// - Transactional texts are held after STOP too (conservative reading; confirm with counsel).
