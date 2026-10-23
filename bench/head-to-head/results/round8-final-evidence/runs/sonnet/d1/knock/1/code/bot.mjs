// SMS send gate. Decides whether one text may go out at the instant `now`.
// Pure: no clock, no storage, no network. Never throws; any doubt holds the text.
//
// Rules (first match wins):
//   invalid-input       user or message is missing or malformed
//   opted-out           user replied STOP (optedOutAt set). Holds ALL kinds.
//   opt-out-unreadable  optedOutAt is set but not a valid timestamp (fail closed)
//   no-consent          marketing only: user.sms.optedIn is not true
//   no-opt-out-language marketing only: text does not tell the reader to reply STOP (CTIA)
//   invalid-now         marketing only: `now` is not a valid Date, so local time is unknown
//   timezone-missing    marketing only: no time zone on the profile
//   timezone-invalid    marketing only: time zone is not a name Intl accepts
//   quiet-hours         marketing only: customer's local time is before 08:00 or at/after 21:00
//                       (47 CFR 64.1200(c)(1))
// Transactional texts skip the consent, footer, time zone and quiet-hours rules.

const QUIET_START_HOUR = 8; // first allowed local hour
const QUIET_END_HOUR = 21; // first blocked local hour in the evening

const hold = (rule) => ({ allowed: false, rule });
const ALLOW = () => ({ allowed: true, rule: '' });

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

function evaluate({ user, message, now }) {
  if (!isObject(user) || !isObject(message)) return hold('invalid-input');
  if (message.kind !== 'marketing' && message.kind !== 'transactional') return hold('invalid-input');
  if (typeof message.text !== 'string' || message.text.trim() === '') return hold('invalid-input');
  if (!isObject(user.sms)) return hold('invalid-input');

  // A STOP reply withdraws consent for every text, including transactional ones.
  const { optedOutAt, optedIn } = user.sms;
  if (optedOutAt !== null && optedOutAt !== undefined) {
    const t = typeof optedOutAt === 'string' ? Date.parse(optedOutAt) : NaN;
    return hold(Number.isNaN(t) ? 'opt-out-unreadable' : 'opted-out');
  }

  if (message.kind === 'transactional') return ALLOW();

  if (optedIn !== true) return hold('no-consent');
  if (!/\bSTOP\b/i.test(message.text)) return hold('no-opt-out-language');

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return hold('invalid-now');

  const tz = user.timeZone;
  if (tz === null || tz === undefined || (typeof tz === 'string' && tz.trim() === '')) {
    return hold('timezone-missing');
  }
  if (typeof tz !== 'string' || /^[+-]/.test(tz.trim())) return hold('timezone-invalid');

  let hour;
  try {
    hour = localHour(now, tz.trim());
  } catch {
    return hold('timezone-invalid');
  }
  if (hour === null) return hold('timezone-invalid');
  if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return hold('quiet-hours');

  return ALLOW();
}

export async function checkSend(input) {
  try {
    return evaluate(isObject(input) ? input : {});
  } catch {
    return hold('invalid-input');
  }
}
