// SMS send gate. checkSend() says whether one text may go out at `now`.
//
// Rules, in the order they are checked. Each held text reports one rule id:
//   invalid-input          user, message or now is malformed (fail closed)
//   invalid-message-kind   kind is not "marketing" or "transactional"
//   empty-text             text is missing or blank
//   opted-out              optedOutAt is set (customer replied STOP). Holds ALL
//                          texts, transactional too: after STOP the only text
//                          allowed is a one-time confirmation of the opt-out,
//                          and this function does not send that.
//   no-consent             sms.optedIn is not exactly true
//   no-opt-out-text        marketing text has no "reply STOP" instruction (CTIA)
//   unknown-time-zone      marketing, and the profile time zone is missing,
//                          invalid, or a UTC placeholder, so local time is unknown
//   quiet-hours            marketing, and customer-local time is outside
//                          8:00 a.m. to 9:00 p.m. (47 CFR 64.1200(c)(1))
//   internal-error         unexpected failure (fail closed)
//
// Transactional texts are not held by quiet hours or by the opt-out-text check.

const QUIET_START_HOUR = 8; // first allowed local hour (08:00)
const QUIET_END_HOUR = 21; // first held local hour (21:00)

const held = (rule) => ({ allowed: false, rule });
const ALLOWED = Object.freeze({ allowed: true, rule: '' });

// "Reply STOP", "text STOP", "STOP to opt out", "STOP2END" style instructions.
const OPT_OUT_INSTRUCTION = /\bstop\b/i;

function validTimeZone(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  // IANA names are Area/Location. This also rejects bare offsets ("+05:00"),
  // which have no daylight saving rules, and bare abbreviations ("EST", "UTC").
  if (!name.includes('/')) return null;
  // Etc/* zones are fixed offsets; a UTC value is most likely a default, not
  // the customer's real zone.
  if (/^etc\//i.test(name)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch {
    return null;
  }
}

function localHour(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return Number.isInteger(hour) ? hour : null;
}

export async function checkSend(input) {
  try {
    const { user, message, now } = input ?? {};
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return held('invalid-input');
    }
    if (!user || typeof user !== 'object' || !message || typeof message !== 'object') {
      return held('invalid-input');
    }

    const { kind, text } = message;
    if (kind !== 'marketing' && kind !== 'transactional') {
      return held('invalid-message-kind');
    }
    if (typeof text !== 'string' || text.trim() === '') {
      return held('empty-text');
    }

    const sms = user.sms;
    if (!sms || typeof sms !== 'object') return held('no-consent');

    // Any value other than null/undefined counts as an opt-out, including an
    // unparseable string: a STOP we cannot read is still a STOP.
    if (sms.optedOutAt !== null && sms.optedOutAt !== undefined) {
      return held('opted-out');
    }
    if (sms.optedIn !== true) return held('no-consent');

    if (kind === 'transactional') return ALLOWED;

    if (!OPT_OUT_INSTRUCTION.test(text)) return held('no-opt-out-text');

    const timeZone = validTimeZone(user.timeZone);
    if (!timeZone) return held('unknown-time-zone');

    const hour = localHour(now, timeZone);
    if (hour === null) return held('unknown-time-zone');
    if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return held('quiet-hours');

    return ALLOWED;
  } catch {
    return held('internal-error');
  }
}
