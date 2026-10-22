// SMS send gate for US recipients.
//
// checkSms(message, now) answers one question: may this text go out right now?
// If not, `reason` names the single rule that blocked it, so support can explain
// the outcome to a customer. The function does no I/O, never sends anything, and
// never reads the server clock or server time zone: the caller passes `now`, and
// quiet hours are computed in the customer's own IANA time zone.
//
// Rule map (check order is the order below; the first failing rule wins):
//
//   invalid_now                    input guard
//   invalid_message                input guard
//   invalid_kind                   input guard (kind must be "marketing" or "transactional")
//   empty_body                     input guard
//   invalid_recipient              input guard
//   invalid_phone                  input guard (must be a US/NANP number in E.164: +1 NXX NXX XXXX)
//   invalid_opt_out_timestamp      optedOutAt is set but is not a parseable date
//   opted_out                      STOP reply on record. Blocks ALL kinds (see note A)
//   no_marketing_consent           marketing only: customer did not tick the marketing sign-up box
//   invalid_time_zone              marketing only: profile time zone is not a valid IANA zone
//   quiet_hours                    marketing only: local time is before 08:00 or at/after 21:00
//   missing_opt_out_language       marketing only: body has no STOP instruction
//
// Legal basis (for the lawyers; this is an engineering mapping, not legal advice):
//
//   A. Revocation. 47 CFR 64.1200(a)(10) requires a caller to honor a consumer's
//      revocation of consent made by any reasonable means, including a reply STOP.
//      The FCC's 2024 "revoke-all" rule extends a revocation to all robocalls and
//      robotexts from that caller, not just the marketing category. CTIA Messaging
//      Principles and Best Practices say STOP ends the program. So an opt-out blocks
//      every kind here, including transactional texts. If product wants transactional
//      texts to continue after STOP, that is a legal decision, not a code change.
//
//   B. Consent for marketing. 47 CFR 64.1200(a)(2) requires prior express written
//      consent before an autodialed or prerecorded telemarketing text to a wireless
//      number. `marketingConsent` must be exactly true. The boolean stands for the
//      sign-up box; the wording of that box and the stored record are outside this function.
//
//   C. Transactional texts are not telemarketing. They are triggered by the customer's
//      own action (for example, a login code they asked for), so they need no marketing
//      consent and no quiet-hours check.
//
//   D. Quiet hours. 47 CFR 64.1200(c)(1) bars telephone solicitations to residential
//      subscribers before 8 a.m. or after 9 p.m. local time at the called party's
//      location. The FCC applies the TCPA's calling rules to texts as well. The window
//      here is 08:00 up to but not including 21:00 in the customer's home zone. The rule
//      says "after 9 p.m.", which strictly allows 9:00:00 p.m.; we block from 21:00:00
//      on as the conservative reading. Home zone is the best proxy we have for the
//      called party's location.
//
//   E. Identification and opt-out language. CTIA Messaging Principles and Best Practices
//      require marketing messages to carry an opt-out path (STOP). This check looks only
//      for the word STOP. It does not check brand identification, message frequency
//      disclosure, or help instructions, and it cannot verify that the brand name appears.

const QUIET_START_MINUTE = 8 * 60; // 08:00 local, inclusive
const QUIET_END_MINUTE = 21 * 60; // 21:00 local, exclusive: blocked from 21:00:00 onward

// NANP: +1, then area code and exchange each starting with 2-9, then 4 digits.
const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const STOP_WORD = /\bSTOP\b/i;

const formatterCache = new Map();

function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

// Returns minutes since local midnight in `timeZone`, or null if the zone is not valid.
function localMinuteOfDay(now, timeZone) {
  let parts;
  try {
    parts = formatterFor(timeZone).formatToParts(now);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  const hour = Number(parts.find((part) => part.type === 'hour').value);
  const minute = Number(parts.find((part) => part.type === 'minute').value);
  return hour * 60 + minute;
}

const allow = () => ({ allowed: true, reason: null });
const block = (reason) => ({ allowed: false, reason });

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return block('invalid_now');
  }
  if (message === null || typeof message !== 'object') {
    return block('invalid_message');
  }

  const { kind, body, to } = message;
  const isMarketing = kind === 'marketing';
  if (!isMarketing && kind !== 'transactional') {
    return block('invalid_kind');
  }
  if (typeof body !== 'string' || body.trim() === '') {
    return block('empty_body');
  }
  if (to === null || typeof to !== 'object') {
    return block('invalid_recipient');
  }
  if (typeof to.phone !== 'string' || !US_E164.test(to.phone)) {
    return block('invalid_phone');
  }

  // Rule A: any STOP on record ends the program for every kind of text.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    if (typeof to.optedOutAt !== 'string' || Number.isNaN(Date.parse(to.optedOutAt))) {
      return block('invalid_opt_out_timestamp');
    }
    return block('opted_out');
  }

  if (!isMarketing) {
    return allow();
  }

  // Rule B: marketing needs prior express written consent.
  if (to.marketingConsent !== true) {
    return block('no_marketing_consent');
  }

  // Rule D: quiet hours, computed in the customer's home zone, never the server's.
  const minute = localMinuteOfDay(now, to.timeZone);
  if (minute === null) {
    return block('invalid_time_zone');
  }
  if (minute < QUIET_START_MINUTE || minute >= QUIET_END_MINUTE) {
    return block('quiet_hours');
  }

  // Rule E: marketing carries an opt-out instruction.
  if (!STOP_WORD.test(body)) {
    return block('missing_opt_out_language');
  }

  return allow();
}
