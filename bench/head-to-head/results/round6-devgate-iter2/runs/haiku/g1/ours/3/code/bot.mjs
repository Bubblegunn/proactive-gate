// Gate for outgoing US SMS. Decides whether one text may go out now. Sends nothing.
//
// Rules applied (see comments at each check):
//  - 47 CFR 64.1200(a)(2): marketing texts need prior express written consent.
//    Here: to.marketingConsent === true.
//  - 47 CFR 64.1200(c)(1): telephone solicitations only between 8:00 a.m. and
//    9:00 p.m. in the called party's local time. Here: [08:00, 21:00) in to.timeZone.
//  - Opt-out: a recorded STOP (to.optedOutAt) blocks unsolicited marketing texts.
//  - CTIA Messaging Principles are guidance, not law. Body checks (STOP wording,
//    HELP, length) are not enforced here.
//
// Customer-triggered transactional texts (login codes, delivery updates) skip the
// consent, opt-out and quiet-hours checks. Only the phone number is validated.

const QUIET_HOURS_END_MIN = 8 * 60; // 08:00 local, inclusive: sending may start here
const QUIET_HOURS_START_MIN = 21 * 60; // 21:00 local, exclusive: sending stops here

// US numbers only, E.164: +1, area code and exchange start with 2-9.
const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

function hold(reason) {
  return { allowed: false, reason };
}

function allow() {
  return { allowed: true, reason: null };
}

// Minutes since local midnight in the given IANA zone. Throws RangeError for an invalid zone.
function localMinutes(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return hour * 60 + minute;
}

export function checkSms(message, now) {
  if (!message || typeof message !== 'object' || !message.to || typeof message.to !== 'object') {
    return hold('invalid_message');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return hold('invalid_now');
  }

  const { kind, to } = message;
  if (kind !== 'marketing' && kind !== 'transactional') {
    return hold('unknown_kind');
  }
  if (typeof to.phone !== 'string' || !US_E164.test(to.phone)) {
    return hold('invalid_phone');
  }

  if (kind === 'transactional') {
    // Customer asked for this text by acting in the app, so consent and opt-out do not apply.
    return allow();
  }

  // Marketing from here on.

  // Opt-out beats every other rule for marketing. Field must be present: null means "never opted out".
  if (to.optedOutAt === undefined) {
    return hold('opt_out_unknown');
  }
  if (to.optedOutAt !== null) {
    if (typeof to.optedOutAt !== 'string' || Number.isNaN(Date.parse(to.optedOutAt))) {
      return hold('invalid_opt_out_timestamp');
    }
    return hold('opted_out');
  }

  // Express written consent (47 CFR 64.1200(a)(2)). Absent or false means no consent.
  if (to.marketingConsent !== true) {
    return hold('marketing_consent_missing');
  }

  // Recipient-local time. An unknown or invalid zone is held, never guessed.
  let minutes;
  try {
    minutes = localMinutes(now, to.timeZone);
  } catch {
    return hold('invalid_time_zone');
  }

  // Telephone solicitation window, 47 CFR 64.1200(c)(1).
  if (minutes < QUIET_HOURS_END_MIN || minutes >= QUIET_HOURS_START_MIN) {
    return hold('quiet_hours');
  }

  return allow();
}
