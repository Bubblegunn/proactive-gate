// SMS gate for US customers. Decides only; never sends.
//
// Rules (reason codes in brackets):
//  - [invalid_message] message missing, kind not marketing/transactional, or body not a non-empty string.
//  - [invalid_phone]   `to.phone` is not a US/NANP number in E.164 form (+1NXXNXXXXXX).
//  - [invalid_now]     `now` is not a valid Date.
//  Marketing only (47 CFR 64.1200(a)(2), (c)(1), (c)(10); CTIA STOP handling):
//  - [opted_out]            optedOutAt is set. Wins over every other marketing rule.
//  - [opt_out_unreadable]   optedOutAt is set but is not a parseable date: treated as unknown, so hold.
//  - [no_marketing_consent] marketingConsent is not exactly true (false, missing or unknown = no).
//  - [invalid_time_zone]    timeZone missing or not a valid IANA zone: unknown, so hold, never guessed.
//  - [outside_calling_hours] recipient local time is outside 08:00-21:00 (start inclusive, end exclusive).
//  Transactional texts (customer-triggered) skip consent, opt-out and hours checks: they are
//  one-time replies to the customer's own action. Not enforced here: body checks such as an
//  opt-out notice in marketing text, state "mini-TCPA" hours, the National DNC registry
//  (no field in the data), and per-recipient frequency caps.

const PHONE_RE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const WINDOW_START_MIN = 8 * 60;
const WINDOW_END_MIN = 21 * 60;

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
    return null;
  }
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block('invalid_now');
  if (
    !message ||
    (message.kind !== 'marketing' && message.kind !== 'transactional') ||
    typeof message.body !== 'string' ||
    message.body.trim() === ''
  ) {
    return block('invalid_message');
  }
  const to = message.to;
  if (!to || typeof to.phone !== 'string' || !PHONE_RE.test(to.phone)) return block('invalid_phone');

  if (message.kind === 'transactional') return { allowed: true, reason: null };

  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    if (typeof to.optedOutAt !== 'string' || Number.isNaN(Date.parse(to.optedOutAt))) {
      return block('opt_out_unreadable');
    }
    return block('opted_out');
  }
  if (to.marketingConsent !== true) return block('no_marketing_consent');

  const minute = localMinuteOfDay(now, to.timeZone);
  if (minute === null) return block('invalid_time_zone');
  if (minute < WINDOW_START_MIN || minute >= WINDOW_END_MIN) return block('outside_calling_hours');

  return { allowed: true, reason: null };
}
