// SMS send gate. Decides whether one text may go out right now.
// Fails closed: anything unclear holds the text with a named rule.
//
// Rules (47 CFR 64.1200 and CTIA Messaging Principles and Best Practices):
//   invalid-input       user or message is malformed
//   invalid-kind        message.kind is not "marketing" or "transactional"
//   empty-message       text is not a non-blank string
//   opted-out           optedOutAt is set (customer replied STOP); holds every kind
//   no-consent          marketing text, but user.sms.optedIn is not exactly true
//   no-opt-out-notice   marketing text does not tell the customer how to opt out
//   invalid-time        marketing text, but `now` is not a valid Date
//   unknown-time-zone   marketing text, but the customer's time zone is missing,
//                       invalid, or a UTC/GMT placeholder, so local time is unknown
//   quiet-hours         marketing text, customer's local time outside 08:00-21:00
//   internal-error      unexpected failure while checking

const WINDOW_START_MINUTES = 8 * 60; // 08:00 local, inclusive
const WINDOW_END_MINUTES = 21 * 60; // 21:00 local, exclusive

// Placeholders that mean "server default", not a customer's real location.
const PLACEHOLDER_ZONE = /^(utc|gmt|z|zulu|uct|universal|greenwich|etc\/.*)$/i;

const hold = (rule) => ({ allowed: false, rule });
const ALLOW = Object.freeze({ allowed: true, rule: '' });

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

// Returns minutes since local midnight, or null if the zone is unusable.
function localMinutes(timeZone, now) {
  if (typeof timeZone !== 'string') return null;
  const zone = timeZone.trim();
  if (zone === '' || PLACEHOLDER_ZONE.test(zone)) return null;
  // Fixed offsets such as "+05:00" are not IANA names and ignore DST.
  if (!/^[A-Za-z]/.test(zone)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

// Marketing text must tell the customer how to stop (CTIA opt-out guidance).
function hasOptOutNotice(text) {
  return /\bstop\b/i.test(text);
}

export async function checkSend(input) {
  try {
    if (!isObject(input)) return hold('invalid-input');
    const { user, message, now } = input;
    if (!isObject(user) || !isObject(message)) return hold('invalid-input');

    const { kind, text } = message;
    if (kind !== 'marketing' && kind !== 'transactional') return hold('invalid-kind');
    if (typeof text !== 'string' || text.trim() === '') return hold('empty-message');

    const sms = user.sms;
    if (!isObject(sms)) return hold(kind === 'marketing' ? 'no-consent' : 'invalid-input');

    // Any value other than null/undefined counts as a STOP, even a malformed
    // timestamp or one dated in the future.
    if (sms.optedOutAt !== null && sms.optedOutAt !== undefined) return hold('opted-out');

    if (kind === 'transactional') return ALLOW;

    // Marketing from here on.
    if (sms.optedIn !== true) return hold('no-consent');
    if (!hasOptOutNotice(text)) return hold('no-opt-out-notice');

    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return hold('invalid-time');

    const minutes = localMinutes(user.timeZone, now);
    if (minutes === null) return hold('unknown-time-zone');
    if (minutes < WINDOW_START_MINUTES || minutes >= WINDOW_END_MINUTES) return hold('quiet-hours');

    return ALLOW;
  } catch {
    return hold('internal-error');
  }
}
