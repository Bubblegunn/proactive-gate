// SMS send gate. checkSend answers one question: may this text go out right now?
// It sends nothing, reads no clock and keeps no state. The caller passes `now`.
//
// Rules, checked in this order. The first rule that holds the text is returned.
//   invalid-input        user, message or now is unusable (fail closed)
//   opted-out            customer replied STOP (any message kind)
//   no-consent           marketing text, customer has not opted in
//   no-opt-out-notice    marketing text does not tell the customer how to stop it
//   url-shortener        marketing text links through a public URL shortener
//   no-timezone          marketing text, customer time zone missing or invalid
//   quiet-hours          marketing text, customer's local time is outside 08:00-21:00
//
// Basis:
//   - 47 CFR 64.1200(c)(1): no telephone solicitation before 8 a.m. or after 9 p.m.
//     at the called party's location. Texts that sell are solicitations.
//   - 47 CFR 64.1200(a)(2) and (a)(10): marketing texts need prior express written
//     consent, and a revocation (STOP) must be honored.
//   - CTIA Messaging Principles and Best Practices: honor opt-out, give opt-out
//     instructions in marketing texts, no public URL shorteners.
// Transactional texts (code or order update the customer asked for) are not
// solicitations, so consent-to-market and the time-of-day window do not apply.

const QUIET_START_MINUTE = 8 * 60; // first allowed minute of the local day
const QUIET_END_MINUTE = 21 * 60; // 21:00 and later is held (conservative reading of "after 9 p.m.")

const SHORTENER_HOSTS = [
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'lnkd.in',
];
const SHORTENER_RE = new RegExp(
  `(?:^|[^a-z0-9.-])(?:${SHORTENER_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})(?:[/?#:\\s]|$)`,
  'i',
);

const hold = (rule) => ({ allowed: false, rule });
const allow = () => ({ allowed: true, rule: '' });

// Minutes since local midnight in `timeZone`, or null if the zone is unusable.
function localMinuteOfDay(timeZone, now) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone.trim(),
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function isValidDate(value) {
  try {
    return Number.isFinite(Date.prototype.getTime.call(value));
  } catch {
    return false;
  }
}

export async function checkSend(input) {
  try {
    // Destructure inside the try block so a null or non-object argument cannot throw.
    const { user, message, now } = input;
    if (!user || typeof user !== 'object' || !message || typeof message !== 'object' || !isValidDate(now)) {
      return hold('invalid-input');
    }

    // Only the exact value "transactional" is transactional. Anything else is marketing.
    const marketing = message.kind !== 'transactional';
    const sms = user.sms && typeof user.sms === 'object' ? user.sms : {};

    // A STOP reply holds every text. Any value other than null/undefined counts as
    // opted out, including an unparseable or future timestamp, so bad data fails closed.
    if (sms.optedOutAt !== null && sms.optedOutAt !== undefined) return hold('opted-out');

    if (!marketing) return allow();

    if (sms.optedIn !== true) return hold('no-consent');

    const text = typeof message.text === 'string' ? message.text : '';
    if (!/\bSTOP\b/i.test(text)) return hold('no-opt-out-notice');
    if (SHORTENER_RE.test(text)) return hold('url-shortener');

    const minute = localMinuteOfDay(user.timeZone, now);
    if (minute === null) return hold('no-timezone');
    if (minute < QUIET_START_MINUTE || minute >= QUIET_END_MINUTE) return hold('quiet-hours');

    return allow();
  } catch {
    return hold('invalid-input');
  }
}
