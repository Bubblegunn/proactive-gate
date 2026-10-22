// SMS gate for US customers. Pure check: sends nothing, keeps no state.
//
// Rules (47 CFR 64.1200 TCPA, CTIA Messaging Principles):
//   marketing: opt-out (STOP) -> consent (prior express written consent)
//              -> calling hours 08:00 to 21:00 at the called party's local time
//              (64.1200(c)(1)); start minute included, end minute excluded.
//   transactional: triggered by the customer, so consent, opt-out and calling
//              hours do not apply. Only the message shape is checked.
// Not enforced: opt-out notice or sender ID in the body (CTIA recommendation).
// Not covered: federal/state Do Not Call lists, stricter state hours, frequency caps.

const START_MINUTE = 8 * 60;
const END_MINUTE = 21 * 60;

const block = (reason) => ({ allowed: false, reason });

function localMinuteOfDay(now, timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour').value);
    const minute = Number(parts.find((p) => p.type === 'minute').value);
    return hour * 60 + minute;
  } catch {
    return null; // RangeError: not a valid IANA zone
  }
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block('invalid_now');
  if (!message || typeof message !== 'object') return block('invalid_message');

  const { kind, to } = message;
  if (kind !== 'marketing' && kind !== 'transactional') return block('invalid_kind');
  if (!to || typeof to !== 'object') return block('invalid_recipient');

  // US numbers only: +1, NANP area code and exchange start with 2-9.
  if (typeof to.phone !== 'string' || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(to.phone)) {
    return block('invalid_phone');
  }

  if (kind === 'transactional') return { allowed: true, reason: null };

  // Marketing. A STOP reply beats every other rule.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    return block('opted_out');
  }
  if (to.marketingConsent !== true) return block('no_marketing_consent');

  const minute = localMinuteOfDay(now, to.timeZone);
  if (minute === null) return block('invalid_time_zone');
  if (minute < START_MINUTE || minute >= END_MINUTE) return block('outside_calling_hours');

  return { allowed: true, reason: null };
}
