// Decides whether one SMS may go out right now. Does not send anything.
//
// Rules applied (rule identifiers returned when a text is held):
//   invalid-input      user, user.sms, message or message.text is missing or has the wrong type
//   opted-out          optedOutAt holds any value (customer replied STOP); holds every kind of text
//   no-consent         marketing text, and sms.optedIn is not exactly true
//   no-opt-out-notice  marketing text does not tell the customer how to opt out ("Reply STOP ...")
//   url-shortener      marketing text links through a public URL shortener (CTIA, carrier filtering)
//   invalid-time       marketing text, and `now` is not a valid Date
//   no-timezone        marketing text, and the customer has no timeZone
//   invalid-timezone   marketing text, and timeZone is not a known IANA name
//   quiet-hours        marketing text, and the local time is before 08:00 or at/after 21:00
//   internal-error     unexpected failure; the text is held
//
// Transactional texts skip consent-for-marketing, content and quiet-hour checks
// (47 CFR 64.1200(c)(1) limits telephone solicitations only), but an opt-out still holds them.
// Any message.kind other than "transactional" is treated as marketing.

const QUIET_START_HOUR = 8; // first local hour marketing may go out
const QUIET_END_HOUR = 21; // first local hour marketing may not go out

const OPT_OUT_NOTICE = /\b(?:reply|text|send)\s+(?:with\s+)?stop\b|\bstop\s+to\s+(?:opt|unsub|cancel|end|quit)/i;

const SHORTENER_DOMAINS = [
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'cutt.ly', 'rb.gy', 'tiny.cc', 'shorturl.at', 't.ly', 'bl.ink',
];
const SHORTENER_PATTERN = new RegExp(
  `(?:^|[\\s(<]|:\\/\\/)(?:${SHORTENER_DOMAINS.map((d) => d.replace(/\./g, '\\.')).join('|')})(?:[/?#:\\s]|$)`,
  'i',
);

const held = (rule) => ({ allowed: false, rule });
const isObject = (v) => typeof v === 'object' && v !== null;

function localHour(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return Number.isInteger(hour) ? hour : null;
}

export async function checkSend({ user, message, now } = {}) {
  try {
    if (!isObject(user) || !isObject(user.sms) || !isObject(message) || typeof message.text !== 'string') {
      return held('invalid-input');
    }

    // Any recorded STOP holds everything. The record has no re-opt-in date,
    // so a non-null value is never overridden by optedIn.
    if (user.sms.optedOutAt !== null && user.sms.optedOutAt !== undefined) {
      return held('opted-out');
    }

    if (message.kind === 'transactional') {
      return { allowed: true, rule: '' };
    }

    // Marketing, including any unknown kind.
    if (user.sms.optedIn !== true) return held('no-consent');
    if (!OPT_OUT_NOTICE.test(message.text)) return held('no-opt-out-notice');
    if (SHORTENER_PATTERN.test(message.text)) return held('url-shortener');

    if (Object.prototype.toString.call(now) !== '[object Date]' || Number.isNaN(now.getTime())) {
      return held('invalid-time');
    }

    const tz = user.timeZone;
    if (tz === null || tz === undefined || (typeof tz === 'string' && tz.trim() === '')) {
      return held('no-timezone');
    }
    if (typeof tz !== 'string') return held('invalid-timezone');

    let hour;
    try {
      hour = localHour(now, tz.trim());
    } catch {
      return held('invalid-timezone');
    }
    if (hour === null) return held('invalid-timezone');
    if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return held('quiet-hours');

    return { allowed: true, rule: '' };
  } catch {
    return held('internal-error');
  }
}
