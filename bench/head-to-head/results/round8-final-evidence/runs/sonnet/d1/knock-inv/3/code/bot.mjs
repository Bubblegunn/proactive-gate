// Decides whether one SMS may go out at `now`. Does not send anything.
//
// Rules (first match holds the text; the identifier is stable per reason):
//   invalid-input      user or message is missing or not an object, or checkSend hit an unexpected error
//   invalid-kind       message.kind is neither "marketing" nor "transactional"
//   empty-text         message.text is not a non-blank string
//   opted-out          customer replied STOP (any non-null optedOutAt). Holds ALL kinds.
//                      47 CFR 64.1200(a)(10) and CTIA: a STOP revokes consent for texts from us.
//   no-consent         marketing only: sms.optedIn is not exactly true
//                      (47 CFR 64.1200(a)(2) and (a)(3): prior express written consent)
//   no-opt-out-notice  marketing only: text does not tell the customer to reply STOP
//                      (CTIA: opt-out instructions in marketing messages; checked on every
//                      message because nothing is stored between calls)
//   unknown-time-zone  marketing only: timeZone is missing, invalid, or a UTC/offset name
//   invalid-time       marketing only: `now` is not a valid Date
//   outside-hours      marketing only: customer's local time is before 08:00 or at/after 21:00
//                      (47 CFR 64.1200(c)(1))
//
// Transactional texts skip the consent, notice, and time-of-day rules (login codes
// and shipping notices must be immediate), but are still held after a STOP.
// Any error fails closed.

const ALLOWED = { allowed: true, rule: '' };
const hold = (rule) => ({ allowed: false, rule });

const FIRST_ALLOWED_HOUR = 8; // 08:00 local
const FIRST_BLOCKED_HOUR = 21; // 21:00 local

// A UTC/GMT or fixed-offset zone is almost certainly a server default, not the customer's place.
const NOT_A_PLACE = /^(utc|gmt|z|zulu|uct|universal|greenwich|etc\/.*|[+-].*)$/i;

function localHour(timeZone, now) {
  if (typeof timeZone !== 'string' || timeZone.trim() !== timeZone || timeZone === '') return null;
  if (NOT_A_PLACE.test(timeZone)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
  } catch {
    return null; // RangeError for an unknown zone name
  }
}

export async function checkSend({ user, message, now } = {}) {
  try {
    if (user === null || typeof user !== 'object') return hold('invalid-input');
    if (message === null || typeof message !== 'object') return hold('invalid-input');

    const kind = message.kind;
    if (kind !== 'marketing' && kind !== 'transactional') return hold('invalid-kind');

    const text = message.text;
    if (typeof text !== 'string' || text.trim() === '') return hold('empty-text');

    // Any value other than null/undefined counts as a STOP, including garbage.
    const optedOutAt = user.sms?.optedOutAt;
    if (optedOutAt !== null && optedOutAt !== undefined) return hold('opted-out');

    if (kind === 'transactional') return ALLOWED;

    if (user.sms?.optedIn !== true) return hold('no-consent');
    if (!/\bSTOP\b/i.test(text)) return hold('no-opt-out-notice');

    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return hold('invalid-time');
    const hour = localHour(user.timeZone, now);
    if (hour === null) return hold('unknown-time-zone');
    if (hour < FIRST_ALLOWED_HOUR || hour >= FIRST_BLOCKED_HOUR) return hold('outside-hours');

    return ALLOWED;
  } catch {
    return hold('invalid-input');
  }
}
