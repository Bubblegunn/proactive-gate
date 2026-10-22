// SMS send gate for US recipients.
//
// checkSms() answers one question: may this text go to the SMS provider right
// now? If not, it returns the code of the first rule that blocked it.
//
// Rules applied (US only):
//   Both kinds
//     - Message must be a known kind with a non-empty body.
//     - Recipient must be a valid NANP (+1) mobile-format number.
//   Transactional (customer-triggered: login codes, delivery updates)
//     - Allowed without consent, without a time window, and after STOP.
//       The customer triggered it, so it is not unsolicited marketing
//       (47 CFR 64.1200(a)(2) and (c)(1) cover telemarketing, not these).
//   Marketing (47 CFR 64.1200 and CTIA Messaging Principles)
//     - Prior express written consent: marketingConsent must be exactly true
//       (64.1200(a)(2)). Missing or unknown values block.
//     - Opt-out: any recorded STOP blocks marketing at once (64.1200(a)(10)
//       allows the consumer to revoke by any reasonable means; the gate does
//       not wait for the carrier's grace period). Unparseable opt-out data
//       blocks, because we cannot prove the customer did not opt out.
//     - Quiet hours: no marketing before 08:00 or at/after 21:00 in the
//       recipient's own time zone (64.1200(c)(1)). The zone comes from
//       to.timeZone, never from the server clock.
//     - Opt-out instructions: the body must contain the keyword STOP
//       (CTIA Messaging Principles: opt-out must be offered in marketing).
//
// Citations are from memory and must be checked against the current CFR text
// and CTIA guide before they go into the legal review.

const ALLOW = Object.freeze({ allowed: true, reason: null });

// Marketing may be sent from this local hour (inclusive) ...
const MARKETING_FROM_HOUR = 8;
// ... up to this local hour (exclusive). 21:00 and later is blocked.
const MARKETING_UNTIL_HOUR = 21;

// NANP: +1, then area code and exchange each starting with 2-9.
const US_PHONE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

// Opt-out keyword that marketing must carry. Case-sensitive: CTIA examples
// use the uppercase keyword, and lowercase "stop" appears in ordinary copy.
const OPT_OUT_KEYWORD = /\bSTOP\b/;

function block(reason) {
  return { allowed: false, reason };
}

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isUsPhone(phone) {
  return typeof phone === 'string' && US_PHONE.test(phone);
}

// Returns the hour (0-23) in the given IANA zone, or null if the zone is
// unknown to Intl. hourCycle h23 avoids the "24:00" quirk of hour12:false.
function localHour(instant, timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return null;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: 'numeric',
    });
  } catch {
    return null;
  }
  const hour = formatter.formatToParts(instant).find((p) => p.type === 'hour');
  return hour ? Number(hour.value) : null;
}

/**
 * @param {{ kind: 'marketing' | 'transactional', body: string,
 *           to: { phone: string, timeZone: string,
 *                 marketingConsent: boolean, optedOutAt: string | null } }} message
 * @param {Date} now the moment of the send attempt
 * @returns {{ allowed: boolean, reason: string | null }}
 */
export function checkSms(message, now) {
  if (!isValidDate(now)) return block('invalid_send_time');
  if (message === null || typeof message !== 'object') return block('invalid_message');

  const { kind, body, to } = message;
  if (kind !== 'marketing' && kind !== 'transactional') return block('invalid_kind');
  if (typeof body !== 'string' || body.trim() === '') return block('empty_body');
  if (to === null || typeof to !== 'object') return block('invalid_recipient');
  if (!isUsPhone(to.phone)) return block('invalid_us_phone');

  if (kind === 'transactional') return ALLOW;

  if (to.marketingConsent !== true) return block('no_marketing_consent');

  if (to.optedOutAt !== null) {
    const optedOut = typeof to.optedOutAt === 'string' ? Date.parse(to.optedOutAt) : NaN;
    if (Number.isNaN(optedOut)) return block('opt_out_status_unknown');
    return block('opted_out');
  }

  const hour = localHour(now, to.timeZone);
  if (hour === null) return block('invalid_time_zone');
  if (hour < MARKETING_FROM_HOUR || hour >= MARKETING_UNTIL_HOUR) {
    return block('outside_marketing_hours');
  }

  if (!OPT_OUT_KEYWORD.test(body)) return block('missing_opt_out_language');

  return ALLOW;
}
