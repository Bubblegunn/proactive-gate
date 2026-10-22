// US SMS send gate. checkSms() decides whether one text may go out now.
// It is a pure function: no I/O, no server clock, no server time zone.
//
// Basis (for the legal review):
// - 47 CFR 64.1200(a)(2): marketing texts sent with automated equipment need
//   prior express written consent. Modeled as marketingConsent === true.
// - 47 CFR 64.1200(c)(1): telemarketing may not be placed before 8:00 a.m. or
//   after 9:00 p.m. at the called party's location. Applied to marketing texts,
//   using the customer's home IANA time zone.
// - 47 CFR 64.1200(a)(10): consent revocation must be honored. Modeled as any
//   non-null optedOutAt blocks all texts (fail closed). The FCC "revoke-all"
//   provision in (a)(10) has a delayed and changing effective date, so counsel
//   must confirm whether a STOP to marketing may still allow transactional.
// - CTIA Messaging Principles and Best Practices: marketing messages carry
//   opt-out instructions; STOP must end the program. Modeled as a "STOP"
//   keyword check on marketing bodies.
// Transactional texts are customer-triggered and informational, so they skip
// the consent, opt-out-language and quiet-hours checks. They still honor STOP.

const QUIET_HOURS_START = 8; // 8:00 a.m. inclusive, local time
const QUIET_HOURS_END = 21; // 9:00 p.m. exclusive, local time

// North American Numbering Plan: +1, then area code and exchange, each
// starting with 2-9.
const US_PHONE_RE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const STOP_KEYWORD_RE = /\bSTOP\b/i;

const KINDS = new Set(['marketing', 'transactional']);

function block(reason) {
  return { allowed: false, reason };
}

// Returns the customer's local hour (0-23) in their IANA time zone, or null if
// the zone is not recognized. Passing timeZone explicitly keeps the server's
// own zone out of the result.
function localHour(now, timeZone) {
  try {
    const part = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .find((p) => p.type === 'hour');
    return part ? Number(part.value) : null;
  } catch {
    return null;
  }
}

export function checkSms(message, now) {
  if (!message || typeof message !== 'object' || !message.to) {
    return block('invalid_message');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return block('invalid_timestamp');
  }

  const { kind, body, to } = message;

  if (!KINDS.has(kind)) {
    return block('unknown_message_kind');
  }
  if (typeof to.phone !== 'string' || !US_PHONE_RE.test(to.phone)) {
    return block('invalid_phone_number');
  }
  if (typeof body !== 'string' || body.trim() === '') {
    return block('empty_body');
  }

  // A STOP reply revokes consent. Texts carry no category field, so the
  // conservative reading applies to every kind of text.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    return block('opted_out');
  }

  if (kind === 'marketing') {
    if (to.marketingConsent !== true) {
      return block('no_marketing_consent');
    }
    if (!STOP_KEYWORD_RE.test(body)) {
      return block('missing_opt_out_language');
    }
    const hour = localHour(now, to.timeZone);
    if (hour === null) {
      return block('invalid_time_zone');
    }
    if (hour < QUIET_HOURS_START || hour >= QUIET_HOURS_END) {
      return block('quiet_hours');
    }
  }

  return { allowed: true, reason: null };
}
