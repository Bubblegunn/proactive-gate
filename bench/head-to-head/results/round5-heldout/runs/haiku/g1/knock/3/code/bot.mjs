// Decides whether one SMS may be sent now and, if not, which rule blocked it.
// Pure function: it never sends anything and never reads the server clock or
// the server time zone. Every time-of-day check uses `to.timeZone`.
//
// Rules (first failing rule wins, so the order below is the order of checks):
//   1. Malformed input                       -> invalid_* codes (fail closed)
//   2. Customer replied STOP                 -> opted_out (all kinds; see notes)
//   3. Marketing without consent             -> no_marketing_consent
//   4. Marketing without opt-out wording     -> marketing_missing_opt_out_instructions
//   5. Marketing outside 08:00-21:00 local   -> marketing_quiet_hours
//
// Legal basis (for the lawyers):
//   - 47 CFR 64.1200(a)(2): telemarketing texts to a wireless number sent with
//     automated equipment need the recipient's prior express written consent.
//     `marketingConsent` stands in for that record; it must be a written,
//     signed-or-E-SIGN-compliant consent captured before the first marketing text.
//   - 47 CFR 64.1200(a)(10): a revocation of consent (STOP) must be honored.
//     This function treats any recorded STOP as revoking every robotext from
//     this sender, not only marketing. That is the conservative reading of the
//     FCC "revoke-all" rule and matches common carrier and provider practice.
//   - 47 CFR 64.1200(c)(1): no telephone solicitations before 8 a.m. or after
//     9 p.m. at the called party's location. Applied to marketing only; the
//     provision covers solicitations, not informational or transactional texts.
//   - CTIA Messaging Principles and Best Practices: marketing programs must
//     tell the recipient how to opt out. Enforced here as the word STOP in the body.
//   - Transactional texts (login codes, delivery updates) are sent because the
//     customer triggered them, so no marketing consent is needed.

const QUIET_HOURS_END = 8;   // marketing allowed from 08:00 local, inclusive
const QUIET_HOURS_START = 21; // marketing allowed until 21:00 local, exclusive

const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const OPT_OUT_WORD = /\bSTOP\b/i;

function allow() {
  return { allowed: true, reason: null };
}

function block(reason) {
  return { allowed: false, reason };
}

// Local hour (0-23) of `date` in the IANA zone `timeZone`. Throws RangeError
// for an unknown zone.
function localHour(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Number(parts.find((part) => part.type === 'hour').value);
}

export function checkSms(message, now) {
  if (!message || typeof message !== 'object') return block('invalid_message');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block('invalid_time');

  const { kind, body, to } = message;
  if (kind !== 'marketing' && kind !== 'transactional') return block('invalid_kind');
  if (!to || typeof to !== 'object') return block('invalid_recipient');
  if (typeof to.phone !== 'string' || !US_E164.test(to.phone)) return block('invalid_phone');
  if (typeof body !== 'string' || body.trim() === '') return block('empty_body');

  // 2. STOP revokes consent for every text from this sender.
  if (to.optedOutAt !== null) {
    if (typeof to.optedOutAt !== 'string' || Number.isNaN(Date.parse(to.optedOutAt))) {
      return block('invalid_opt_out_timestamp');
    }
    return block('opted_out');
  }

  if (kind === 'transactional') return allow();

  // 3. Marketing needs recorded prior written consent.
  if (to.marketingConsent !== true) return block('no_marketing_consent');

  // 4. Marketing must tell the customer how to opt out.
  if (!OPT_OUT_WORD.test(body)) return block('marketing_missing_opt_out_instructions');

  // 5. Quiet hours use the customer's home zone, never the server zone.
  if (typeof to.timeZone !== 'string') return block('invalid_time_zone');
  let hour;
  try {
    hour = localHour(now, to.timeZone);
  } catch {
    return block('invalid_time_zone');
  }
  if (hour < QUIET_HOURS_END || hour >= QUIET_HOURS_START) {
    return block('marketing_quiet_hours');
  }

  return allow();
}
