// Decides whether one SMS may go out now, under US rules.
// Pure function: sends nothing and keeps no state. The caller sends only when allowed is true.
//
// Marketing texts (47 CFR 64.1200):
//   - the customer must have opted in to marketing (marketingConsent === true)
//   - a STOP reply (optedOutAt set) blocks them
//   - they may go only 08:00 to 21:00 in the customer's own time zone (64.1200(c)(1))
// Transactional texts (customer-triggered: login codes, delivery updates) are not
// blocked by consent, STOP or hours. Only the phone format and the kind are checked.

const MARKETING_START_MINUTE = 8 * 60; // 08:00 local, included
const MARKETING_END_MINUTE = 21 * 60; // 21:00 local, excluded

// North American Numbering Plan: +1, area code and exchange start with 2-9.
const NANP_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

function block(reason) {
  return { allowed: false, reason };
}

// Minute of the day (0-1439) at `now` in `timeZone`, or null when the zone is unknown.
// Passing an explicit zone keeps the server's own zone out of the result.
function localMinuteOfDay(now, timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(now);
  } catch {
    return null;
  }
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return hour * 60 + minute;
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block('invalid_now');

  const kind = message?.kind;
  if (kind !== 'marketing' && kind !== 'transactional') return block('invalid_kind');

  const to = message.to;
  if (typeof to?.phone !== 'string' || !NANP_E164.test(to.phone)) return block('invalid_phone');

  if (kind === 'transactional') {
    return { allowed: true, reason: null };
  }

  // Marketing from here on.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) return block('opted_out');
  if (to.marketingConsent !== true) return block('no_marketing_consent');

  const minute = localMinuteOfDay(now, to.timeZone);
  if (minute === null) return block('invalid_time_zone');
  if (minute < MARKETING_START_MINUTE || minute >= MARKETING_END_MINUTE) {
    return block('outside_marketing_hours');
  }

  return { allowed: true, reason: null };
}
