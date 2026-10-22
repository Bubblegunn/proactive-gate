// SMS pre-send gate for US customers.
//
// checkSms(message, now) -> { allowed: boolean, reason: string | null }
// Pure function: no network, no I/O, no dependence on the server's time zone.
// The first rule that fails decides the reason; every rule has its own code.
//
// Rule map for compliance review. Citations come from the authors' reading of
// 47 CFR 64.1200 and the CTIA Messaging Principles and Best Practices. Verify
// them against the current text before relying on them.
//
//   invalid_message, invalid_now, unknown_kind, empty_body,
//   invalid_phone_number, invalid_time_zone, invalid_opt_out_timestamp
//       Input validation. Fail closed: a malformed message is never sent.
//   promotional_content_labeled_transactional
//       Transactional texts must not carry promotions. Promotional content needs
//       the marketing rules (prior express written consent, opt-out, quiet hours).
//       Heuristic: a keyword list cannot catch every promotion.
//   opted_out
//       A STOP reply revokes marketing consent. Applies to marketing only. See the
//       note at the transactional branch below. (47 CFR 64.1200(a)(10); CTIA)
//   no_marketing_consent
//       Marketing texts need the customer's prior express written consent.
//       (47 CFR 64.1200(a)(2))
//   missing_opt_out_language
//       Marketing texts must tell the recipient how to opt out. (CTIA)
//   quiet_hours
//       No telemarketing before 8:00 or at/after 21:00 in the called party's local
//       time. (47 CFR 64.1200(c)(1))

const US_PHONE = /^\+1[2-9]\d{9}$/;
const OPT_OUT_WORD = /\bSTOP\b/i;
const PROMOTIONAL = /\b(sale|coupon|promo|promotion|promo code|discount|deal|back in stock|shop now)\b|\d+\s?%\s?off/i;

// Local minutes after midnight. Sends are allowed in [08:00, 21:00).
const QUIET_START = 8 * 60;
const QUIET_END = 21 * 60;

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function localMinutes(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return hour * 60 + minute;
}

// Returns { valid, optedOut }. A null/undefined value means no opt-out.
// A timestamp after `now` is treated as malformed rather than as an opt-out.
function readOptOut(optedOutAt, now) {
  if (optedOutAt === null || optedOutAt === undefined) return { valid: true, optedOut: false };
  if (typeof optedOutAt !== 'string') return { valid: false, optedOut: false };
  const at = Date.parse(optedOutAt);
  if (Number.isNaN(at) || at > now.getTime()) return { valid: false, optedOut: false };
  return { valid: true, optedOut: true };
}

export function checkSms(message, now) {
  const block = (reason) => ({ allowed: false, reason });
  const allow = () => ({ allowed: true, reason: null });

  if (!message || typeof message !== 'object' || !message.to || typeof message.to !== 'object') {
    return block('invalid_message');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block('invalid_now');

  const { kind, body, to } = message;
  if (kind !== 'marketing' && kind !== 'transactional') return block('unknown_kind');
  if (typeof body !== 'string' || body.trim() === '') return block('empty_body');
  if (typeof to.phone !== 'string' || !US_PHONE.test(to.phone)) return block('invalid_phone_number');
  if (!isValidTimeZone(to.timeZone)) return block('invalid_time_zone');

  const optOut = readOptOut(to.optedOutAt, now);
  if (!optOut.valid) return block('invalid_opt_out_timestamp');

  if (kind === 'transactional') {
    if (PROMOTIONAL.test(body)) return block('promotional_content_labeled_transactional');
    // Open point for counsel: a STOP reply does not block transactional texts
    // here, because the customer asked for them (login code, delivery update).
    // Carrier-level blocking still applies on the provider side.
    return allow();
  }

  if (optOut.optedOut) return block('opted_out');
  if (to.marketingConsent !== true) return block('no_marketing_consent');
  if (!OPT_OUT_WORD.test(body)) return block('missing_opt_out_language');

  const minutes = localMinutes(now, to.timeZone);
  if (minutes < QUIET_START || minutes >= QUIET_END) return block('quiet_hours');

  return allow();
}
