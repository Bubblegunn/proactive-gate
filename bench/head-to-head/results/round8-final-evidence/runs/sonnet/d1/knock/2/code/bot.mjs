// SMS send gate. checkSend decides whether one text may go out at `now`.
// Rules (47 CFR 64.1200, CTIA Messaging Principles and Best Practices):
//   - STOP / opt-out is honored for every kind of text.
//   - Marketing needs prior express consent (sms.optedIn === true).
//   - Marketing is held outside 8:00-20:59 local time of the customer
//     (47 CFR 64.1200(c)(1)). Unknown or invalid time zone: held, because
//     the local time cannot be known.
//   - Marketing text must tell the customer how to opt out (STOP).
// Anything that cannot be checked is held (fail closed), never thrown.

const QUIET_START_HOUR = 8; // first allowed local hour
const QUIET_END_HOUR = 21; // first disallowed local hour (9 pm)

const hold = (rule) => ({ allowed: false, rule });
const allow = () => ({ allowed: true, rule: '' });

function localHour(now, timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone.trim(),
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
  } catch {
    return null;
  }
}

export async function checkSend(input) {
  try {
    const { user, message, now } = input ?? {};
    if (!user || typeof user !== 'object' || !message || typeof message !== 'object') {
      return hold('invalid-input');
    }
    const { kind, text } = message;
    if (kind !== 'marketing' && kind !== 'transactional') return hold('invalid-kind');
    if (typeof text !== 'string' || text.trim() === '') return hold('empty-text');

    const sms = user.sms;
    if (!sms || typeof sms !== 'object') return hold('no-consent');

    // Any recorded opt-out holds the text, even if the timestamp is
    // unparseable or in the future.
    if (sms.optedOutAt !== null && sms.optedOutAt !== undefined) return hold('opted-out');

    if (kind === 'transactional') return allow();

    // Marketing from here on.
    if (sms.optedIn !== true) return hold('no-consent');

    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return hold('invalid-time');
    const hour = localHour(now, user.timeZone);
    if (hour === null) return hold('unknown-timezone');
    if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return hold('quiet-hours');

    if (!/\bstop\b/i.test(text)) return hold('no-opt-out-text');

    return allow();
  } catch {
    return hold('check-failed');
  }
}
