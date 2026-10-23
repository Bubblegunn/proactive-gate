// SMS send gate. checkSend() answers: may this text go out right now?
//
// Rules, in the order they are checked. The first one that fails is returned.
//   invalid-input        user or message is missing or malformed
//   opted-out            customer replied STOP (any non-null optedOutAt), all kinds held
//   no-consent           marketing text and sms.optedIn is not exactly true
//   missing-opt-out-text marketing text has no "STOP" opt-out instruction (CTIA)
//   unknown-time-zone    marketing text and the profile time zone is missing or not usable
//   invalid-time         marketing text and `now` is not a valid Date
//   quiet-hours          marketing text outside the local sending window
//
// Marketing is held to the strictest reading of 47 CFR 64.1200(c)(1) (no calls
// before 8 a.m. or after 9 p.m. recipient local time), CTIA quiet-hours guidance
// and the stricter state "mini-TCPA" limits (FL, MD, OK, WA: 8 p.m.; TX: Sunday
// noon). The window used is 09:00 to 20:00 local, Sunday 12:00 to 20:00. This also
// fits India (09:00 to 21:00) and Japan.

const QUIET_START_MIN = 9 * 60;
const SUNDAY_START_MIN = 12 * 60;
const QUIET_END_MIN = 20 * 60;

// A text labelled transactional that also sells something is treated as marketing
// (FCC dual-purpose rule). Words are chosen so login codes and shipping notices
// do not match.
const PROMO_PATTERNS = [
  /\d\s*%\s*off\b/i,
  /\b(?:sale|sales|discounts?|coupons?|promos?|promotions?|promotional|deals?|offers?|bogo|clearance)\b/i,
  /\b(?:use|enter|apply)\s+(?:the\s+)?(?:code|promo)\b/i,
  /\bfree\s+(?:shipping|gift|box|trial)\b/i,
  /\b(?:shop|buy|order|subscribe|upgrade)\s+now\b/i,
  /\b(?:limited[- ]time|flash|exclusive|last chance|while supplies last|don't miss)\b/i,
  /\bsave\s+(?:up to\s+)?[$€£¥₹]?\s*\d/i,
];

function isPlainObject(v) {
  return typeof v === "object" && v !== null;
}

// Returns an Intl.DateTimeFormat for a usable IANA zone, or null. Bare "UTC",
// "GMT", "Etc/*" and fixed offsets are rejected: for a customer profile they are
// defaults, not a real location.
function localFormatter(timeZone) {
  if (typeof timeZone !== "string") return null;
  const tz = timeZone.trim();
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(tz)) return null;
  if (/^etc\//i.test(tz)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
    });
  } catch {
    return null;
  }
}

function localParts(fmt, date) {
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return { weekday: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function evaluate({ user, message, now }) {
  if (!isPlainObject(user) || !isPlainObject(message)) return "invalid-input";
  if (typeof message.text !== "string" || message.text.trim() === "") return "invalid-input";

  // Anything other than the exact string "transactional" counts as marketing.
  const declaredTransactional = message.kind === "transactional";
  const isMarketing =
    !declaredTransactional || PROMO_PATTERNS.some((re) => re.test(message.text));

  const sms = isPlainObject(user.sms) ? user.sms : null;

  // A recorded STOP holds every kind. Any non-null value counts, even one we
  // cannot parse or one dated after `now`, because the cost of a wrong send is
  // higher than the cost of a held text.
  if (sms !== null && sms.optedOutAt !== null && sms.optedOutAt !== undefined) {
    return "opted-out";
  }

  if (!isMarketing) return "";

  if (sms === null || sms.optedIn !== true) return "no-consent";
  if (!/\bstop\b/i.test(message.text)) return "missing-opt-out-text";

  const fmt = localFormatter(user.timeZone);
  if (fmt === null) return "unknown-time-zone";

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return "invalid-time";

  const { weekday, minutes } = localParts(fmt, now);
  const start = weekday === "Sun" ? SUNDAY_START_MIN : QUIET_START_MIN;
  if (minutes < start || minutes >= QUIET_END_MIN) return "quiet-hours";

  return "";
}

export async function checkSend(args) {
  try {
    const rule = evaluate({ user: args?.user, message: args?.message, now: args?.now });
    return { allowed: rule === "", rule };
  } catch {
    return { allowed: false, rule: "invalid-input" };
  }
}
