// US SMS send gate. Decides only, never sends.
//
// Marketing texts (sent by the AI agent on its own) are allowed only when:
//   - the customer gave marketing consent (sign-up box ticked),
//   - no STOP is on record, and
//   - it is 08:00 to 21:00 in the customer's own time zone (TCPA, 47 CFR 64.1200).
// Transactional texts (the customer triggered them in the app) pass these rules.

// Recipient-local minutes after midnight. Start is included, end is excluded.
const WINDOW_START_MIN = 8 * 60;
const WINDOW_END_MIN = 21 * 60;

// Local time comes from Intl with the recipient's zone, so the server's zone never matters.
function localMinutesOfDay(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return hour * 60 + minute;
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('checkSms: now must be a valid Date');
  }

  const kind = message?.kind;
  if (kind !== 'marketing' && kind !== 'transactional') {
    return { allowed: false, reason: 'unknown_message_kind' };
  }
  if (kind === 'transactional') {
    return { allowed: true, reason: null };
  }

  const to = message.to ?? {};

  // Absent or false consent means no consent.
  if (to.marketingConsent !== true) {
    return { allowed: false, reason: 'marketing_no_consent' };
  }

  // null means never opted out. A valid ISO timestamp means STOP was received.
  // Anything else (missing or malformed) is unknown, so hold.
  const { optedOutAt } = to;
  if (optedOutAt !== null) {
    if (typeof optedOutAt !== 'string' || Number.isNaN(Date.parse(optedOutAt))) {
      return { allowed: false, reason: 'opt_out_status_unknown' };
    }
    return { allowed: false, reason: 'opted_out' };
  }

  // Without a usable zone the local window cannot be checked, so hold. Never guess.
  if (typeof to.timeZone !== 'string') {
    return { allowed: false, reason: 'invalid_timezone' };
  }
  let minutes;
  try {
    minutes = localMinutesOfDay(now, to.timeZone);
  } catch {
    return { allowed: false, reason: 'invalid_timezone' };
  }
  if (minutes < WINDOW_START_MIN || minutes >= WINDOW_END_MIN) {
    return { allowed: false, reason: 'outside_marketing_hours' };
  }

  return { allowed: true, reason: null };
}
