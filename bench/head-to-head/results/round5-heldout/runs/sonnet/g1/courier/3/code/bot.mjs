// SMS send gate for US recipients. Pure and synchronous: it sends nothing.
//
// checkSms(message, now) -> { allowed: boolean, reason: string | null }
//
// Rules, in the order they are checked. The first rule that fails decides the reason code.
// Every check fails closed: data we cannot read never lets a marketing text through.
//
//  1. invalid_message       message, kind or recipient is missing or malformed.
//  2. unknown_kind          kind is not "marketing" or "transactional".
//  3. empty_body            body is not a non-blank string.
//  4. invalid_phone         "to.phone" is not a US/NANP E.164 number (+1 and 10 digits).
//  5. opted_out             MARKETING only. The customer replied STOP (optedOutAt is set).
//                           47 CFR 64.1200(a)(10) (revocation of consent by any reasonable
//                           means) and the CTIA principle that STOP ends the program.
//                           An unreadable optedOutAt also blocks (invalid_opted_out_at).
//  6. no_marketing_consent  MARKETING only. marketingConsent is not exactly true.
//                           47 CFR 64.1200(a)(2): marketing texts sent with an autodialer
//                           (AI-chosen sends count) need prior express written consent.
//                           CTIA: opt-in is required before marketing messages.
//  7. quiet_hours           MARKETING only. 47 CFR 64.1200(c)(1): no telephone solicitation
//                           before 8 a.m. or after 9 p.m. at the called party's location.
//                           Allowed window: 08:00:00.000 up to but not including 21:00:00.000
//                           in to.timeZone. A bad zone blocks (invalid_time_zone).
//
// Transactional texts (login codes, delivery updates the customer triggered) are not
// telephone solicitations, so rules 5-7 do not apply to them. They still need rules 1-4.
//
// Not covered, because the message has no data for it: the National Do-Not-Call Registry
// (64.1200(c)(2)), reassigned-number checks, state "mini-TCPA" laws with stricter hours
// (for example Florida and Oklahoma), carrier content rules, and the CTIA advice to name
// the sender and give STOP/HELP instructions in the text. Those need other inputs.

const QUIET_START_HOUR = 8; // inclusive
const QUIET_END_HOUR = 21; // exclusive

const deny = (reason) => ({ allowed: false, reason });
const ALLOW = () => ({ allowed: true, reason: null });

const isObject = (v) => typeof v === 'object' && v !== null;

// US/Canada numbers: +1, area code and exchange start with 2-9.
const US_PHONE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

// ISO 8601 date or date-time. Date.parse alone is too lenient (it accepts "March 3").
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// Local hour (0-23) of `now` in an IANA zone, or null if the zone is invalid.
// Intl applies the zone's DST rules for that exact instant; the server zone is never used.
function localHour(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    return Number.isInteger(hour) ? hour % 24 : null;
  } catch {
    return null;
  }
}

export function checkSms(message, now) {
  if (!isObject(message) || !isObject(message.to)) return deny('invalid_message');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny('invalid_now');

  const { kind, body, to } = message;

  if (kind !== 'marketing' && kind !== 'transactional') return deny('unknown_kind');
  if (typeof body !== 'string' || body.trim() === '') return deny('empty_body');
  if (typeof to.phone !== 'string' || !US_PHONE.test(to.phone)) return deny('invalid_phone');

  if (kind === 'transactional') return ALLOW();

  // Marketing from here on.
  const { optedOutAt } = to;
  if (optedOutAt !== null && optedOutAt !== undefined) {
    if (typeof optedOutAt !== 'string' || !ISO_8601.test(optedOutAt) || Number.isNaN(Date.parse(optedOutAt))) {
      return deny('invalid_opted_out_at');
    }
    // Any recorded STOP blocks, even one dated after `now` (clock skew): fail closed.
    return deny('opted_out');
  }

  if (to.marketingConsent !== true) return deny('no_marketing_consent');

  const hour = typeof to.timeZone === 'string' ? localHour(now, to.timeZone) : null;
  if (hour === null) return deny('invalid_time_zone');
  if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return deny('quiet_hours');

  return ALLOW();
}
