// SMS send gate. Decides whether one text may go out at the instant `now`.
// Never reads the system clock, never throws, stores nothing.
//
// Rules, in the order they are checked (each returns its own identifier):
//   invalid-user        user is not an object, so opt-out status cannot be known
//   opted-out           optedOutAt is set (STOP). Holds ALL texts, transactional too
//                       (47 CFR 64.1200(a)(10): revocation applies to every text
//                       from the sender; CTIA: honor STOP).
//   invalid-message     text is missing, not a string, or blank
//   no-consent          marketing text, and sms.optedIn is not exactly true
//                       (47 CFR 64.1200(a)(2): prior express written consent)
//   missing-opt-out     marketing text without "Reply STOP ..." style opt-out wording
//                       (CTIA Messaging Principles: opt-out instructions)
//   invalid-time        marketing text and `now` is not a valid Date
//   unknown-time-zone   marketing text and the profile time zone is missing or not a
//                       real IANA zone, so the customer's local time is unknown
//   quiet-hours         marketing text outside 08:00-20:59 customer local time
//                       (47 CFR 64.1200(c)(1): not before 8 a.m. or after 9 p.m.)
//
// Anything whose kind is not exactly "transactional" is treated as marketing.
// A "transactional" text that contains promotional wording is also treated as
// marketing (the FCC treats a text that advertises as telemarketing).

const PROMO = /\b(\d+\s*%\s*off|\d+\s*percent\s+off|sale|discount|coupon|promo(?:tion|\s*code)?|(?:use|enter)\s+code|limited[- ]time|shop\s+now|buy\s+now|free\s+gift|deal)\b|%\s*off/i;
const OPT_OUT =
  /\b(?:reply|text|txt|send|respond)\s+["'“]?stop\b|\bstop\s+to\s+(?:opt[- ]?out|unsubscribe|cancel|end|quit|stop)\b|\bunsubscribe\b/i;

const QUIET_START_HOUR = 8; // first allowed local hour
const QUIET_END_HOUR = 21; // first disallowed local hour (9 p.m.)

const hold = (rule) => ({ allowed: false, rule });
const ok = () => ({ allowed: true, rule: '' });

function localHour(now, timeZone) {
  try {
    if (typeof timeZone !== 'string' || timeZone === '') return null;
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
  } catch {
    return null; // RangeError for an unknown time zone
  }
}

function isValidZone(timeZone) {
  try {
    if (typeof timeZone !== 'string' || timeZone === '') return false;
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export async function checkSend(input) {
  try {
    const { user, message, now } = input ?? {};
    if (user === null || typeof user !== 'object') return hold('invalid-user');

    const sms = user.sms !== null && typeof user.sms === 'object' ? user.sms : {};

    // Any recorded opt-out holds everything. Fail closed: any non-null value counts.
    if (sms.optedOutAt !== null && sms.optedOutAt !== undefined) return hold('opted-out');

    const text = message !== null && typeof message === 'object' ? message.text : undefined;
    if (typeof text !== 'string' || text.trim() === '') return hold('invalid-message');

    const kind = message.kind;
    const isMarketing = kind !== 'transactional' || PROMO.test(text);

    if (!isMarketing) return ok();

    if (sms.optedIn !== true) return hold('no-consent');
    if (!OPT_OUT.test(text)) return hold('missing-opt-out');

    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return hold('invalid-time');
    if (!isValidZone(user.timeZone)) return hold('unknown-time-zone');

    const hour = localHour(now, user.timeZone);
    if (hour === null) return hold('unknown-time-zone');
    if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return hold('quiet-hours');

    return ok();
  } catch {
    return hold('check-failed');
  }
}
