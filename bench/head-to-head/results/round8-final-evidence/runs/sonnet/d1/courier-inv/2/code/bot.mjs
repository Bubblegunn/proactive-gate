// Pre-send gate for SMS. Decides only; it never sends anything and keeps no state.
//
// Rules, in the order they are checked (the first one that fails is reported):
//   invalid-user        user object missing or malformed, so opt-out status is unknown
//   empty-text          message has no text
//   opted-out           optedOutAt is set (customer replied STOP). Blocks every kind of message.
//   no-consent          marketing only: sms.optedIn is not exactly true
//   no-opt-out-notice   marketing only: text does not tell the customer how to stop (STOP)
//   invalid-time        marketing only: `now` is not a valid Date
//   unknown-timezone    marketing only: timeZone missing or not a real IANA zone
//   quiet-hours         marketing only: customer's local time is outside 08:00-21:00
//
// Basis: 47 CFR 64.1200(c)(1) (no telephone solicitations before 8 a.m. or after 9 p.m.
// at the called party's location), 64.1200(a)(2) and (a)(10) (prior express written
// consent for marketing texts; revocation must be honored), and CTIA Messaging
// Principles (consent, honor STOP, opt-out instructions in marketing).
// Not covered: state rules that are stricter than the FCC's (for example Florida and
// Maryland end at 8 p.m.), frequency caps, and the National Do Not Call Registry.

const QUIET_START_HOUR = 8; // first allowed local hour, inclusive
const QUIET_END_HOUR = 21; // first blocked local hour (9 p.m.), exclusive

// A text that is "transactional" but sells something is a marketing text under the
// FCC rules. These phrases are strong sales signals and reclassify the text.
const PROMO_PATTERN =
  /(\d\s*%\s*off|[$€£]\s*\d+(?:\.\d+)?\s*off|\b(?:discounts?|promo(?:tion|tional)?(?:\s+code)?|coupons?|sale|limited[- ]time|shop now|buy now|use code|save \d+|deals?|free shipping|flash sale|bogo)\b)/i;

const STOP_PATTERN = /\bSTOP\b/i;

const hold = (rule) => ({ allowed: false, rule });
const ALLOW = Object.freeze({ allowed: true, rule: '' });

function localHour(now, timeZone) {
  // Throws RangeError when timeZone is not a valid zone; the caller handles that.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hourPart = parts.find((p) => p.type === 'hour');
  if (!hourPart) return null;
  const hour = Number.parseInt(hourPart.value, 10);
  return Number.isInteger(hour) ? hour % 24 : null;
}

export async function checkSend(input) {
  try {
    const { user, message, now } = input ?? {};
    const sms = user && typeof user === 'object' ? user.sms : undefined;
    if (!sms || typeof sms !== 'object') return hold('invalid-user');

    const text = message && typeof message === 'object' ? message.text : undefined;
    if (typeof text !== 'string' || text.trim() === '') return hold('empty-text');

    // Any value other than null/undefined counts as an opt-out, including an
    // unparseable string. Failing closed is cheaper than an unwanted text after STOP.
    // A STOP revokes consent for all texts from us, so transactional texts are held too.
    if (sms.optedOutAt !== null && sms.optedOutAt !== undefined) return hold('opted-out');

    const isTransactional = message.kind === 'transactional' && !PROMO_PATTERN.test(text);
    if (isTransactional) return ALLOW; // the customer asked for it; no quiet hours apply

    // Everything else is marketing.
    if (sms.optedIn !== true) return hold('no-consent');
    if (!STOP_PATTERN.test(text)) return hold('no-opt-out-notice');

    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return hold('invalid-time');

    const timeZone = user.timeZone;
    if (typeof timeZone !== 'string' || timeZone.trim() === '') return hold('unknown-timezone');
    let hour;
    try {
      hour = localHour(now, timeZone.trim());
    } catch {
      return hold('unknown-timezone');
    }
    if (hour === null) return hold('unknown-timezone');

    if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return hold('quiet-hours');
    return ALLOW;
  } catch {
    return hold('internal-error');
  }
}
