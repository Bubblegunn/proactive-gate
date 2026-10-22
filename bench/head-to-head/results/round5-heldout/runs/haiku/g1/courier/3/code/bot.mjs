// bot.mjs: decides whether one SMS may go out right now.
// Covers US rules: TCPA (47 CFR 64.1200) and CTIA Messaging Principles.
// Pure function: no I/O, no reading of the clock (uses `now`), no dependence on the server's time zone.

const US_PHONE = /^\+1([2-9]\d{2})([2-9]\d{2})\d{4}$/;
const STOP_WORD = /\bSTOP\b/i;

// 64.1200(c)(1): telephone solicitations only between 8 a.m. and 9 p.m. local time of the called party.
const QUIET_START_HOUR = 8;
const QUIET_END_HOUR = 21; // hour 21 (9 p.m.) is already blocked

const ALLOWED = Object.freeze({ allowed: true, reason: null });

function blocked(reason) {
  return { allowed: false, reason };
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Hour (0-23) of `now` on the customer's clock. Intl handles DST; the server zone is never consulted.
function localHour(now, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });
  return Number(fmt.formatToParts(now).find((part) => part.type === 'hour').value);
}

/**
 * @param {{kind: 'marketing'|'transactional', body: string, to: {phone: string, timeZone: string, marketingConsent: boolean, optedOutAt: string|null}}} message
 * @param {Date} now
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return blocked('invalid_input');
  if (!message || typeof message !== 'object') return blocked('invalid_input');

  const { kind, body, to } = message;
  if (kind !== 'marketing' && kind !== 'transactional') return blocked('invalid_input');
  if (typeof body !== 'string' || body.trim() === '') return blocked('invalid_input');
  if (!to || typeof to !== 'object') return blocked('invalid_input');

  // The customer's number must be a US (NANP) number; anything else is refused.
  if (typeof to.phone !== 'string' || !US_PHONE.test(to.phone)) return blocked('invalid_phone_number');

  // optedOutAt: null, or an ISO 8601 string for the STOP reply. Anything else fails closed.
  if (to.optedOutAt !== null) {
    if (typeof to.optedOutAt !== 'string' || Number.isNaN(Date.parse(to.optedOutAt))) {
      return blocked('invalid_input');
    }
    // A STOP reply ends the program: marketing stops (64.1200(a)(10), CTIA opt-out),
    // and CTIA's opt-out applies to the whole messaging program, so transactional texts stop too.
    return blocked(kind === 'marketing' ? 'opted_out' : 'opted_out_transactional');
  }

  // Transactional texts (login codes, delivery updates) are triggered by the customer's own action.
  // Giving the number for that purpose is the consent, so no marketing checks apply.
  if (kind === 'transactional') return ALLOWED;

  // Marketing: prior express written consent is required (64.1200(a)(2)).
  // Only a strict `true` counts; a missing or non-boolean value is treated as no consent.
  if (to.marketingConsent !== true) return blocked('no_marketing_consent');

  // Quiet hours are judged on the customer's home clock, using their IANA time zone.
  if (typeof to.timeZone !== 'string' || !isValidTimeZone(to.timeZone)) return blocked('invalid_time_zone');
  const hour = localHour(now, to.timeZone);
  if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return blocked('quiet_hours');

  // CTIA: a marketing text must tell the customer how to opt out.
  if (!STOP_WORD.test(body)) return blocked('missing_opt_out_text');

  return ALLOWED;
}
