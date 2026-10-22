// US SMS send gate. Decides whether one text may go out now. Never sends.
// Stateless: every input it needs arrives in `message` and `now`.

// Rough E.164 check for US numbers: +1, then a 10-digit NANP number (area code and exchange start 2-9).
const US_PHONE_RE = /^\+1[2-9]\d{9}$/;

// CTIA: a marketing text must tell the recipient how to opt out.
const OPT_OUT_INSTRUCTION_RE = /\b(reply|text)\s+stop\b/i;

// 47 CFR 64.1200(c)(1): no telemarketing before 8 a.m. or after 9 p.m. in the called party's local time.
// 08:00 is allowed, 21:00 is not.
const QUIET_START_MIN = 8 * 60;
const QUIET_END_MIN = 21 * 60;

const KINDS = new Set(['marketing', 'transactional']);

function block(reason) {
  return { allowed: false, reason };
}

// Minute of the day (0-1439) in the given IANA zone. Throws RangeError for an unknown zone.
function localMinuteOfDay(now, timeZone) {
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
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return block('invalid_now');
  }

  const { kind, body, to } = message ?? {};
  if (!KINDS.has(kind)) return block('invalid_message_kind');
  if (typeof body !== 'string' || body.trim() === '') return block('invalid_body');
  if (typeof to?.phone !== 'string' || !US_PHONE_RE.test(to.phone)) return block('invalid_phone');

  // Opt-out (a STOP reply) stops every text from us to this number, both kinds.
  // Null means no STOP on record. Any other value is a STOP timestamp.
  const { optedOutAt } = to;
  if (optedOutAt !== null && optedOutAt !== undefined) {
    if (typeof optedOutAt !== 'string' || Number.isNaN(Date.parse(optedOutAt))) {
      return block('invalid_opt_out_record');
    }
    return block('opted_out');
  }

  // Transactional: sent because the customer just did something in the app. No consent
  // or hour limit applies (the TCPA time rule covers telemarketing).
  if (kind === 'transactional') return { allowed: true, reason: null };

  // Marketing from here on.
  // Prior express written consent: the customer ticked the marketing sign-up box.
  // Absent or non-true means no consent.
  if (to.marketingConsent !== true) return block('no_marketing_consent');

  if (!OPT_OUT_INSTRUCTION_RE.test(body)) return block('missing_opt_out_instructions');

  // Quiet hours use the customer's home zone, never the server's zone.
  let minute;
  try {
    minute = localMinuteOfDay(now, to.timeZone);
  } catch {
    return block('invalid_time_zone');
  }
  if (minute < QUIET_START_MIN || minute >= QUIET_END_MIN) return block('quiet_hours');

  return { allowed: true, reason: null };
}
