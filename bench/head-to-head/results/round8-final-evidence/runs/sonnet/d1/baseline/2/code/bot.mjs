// Pre-send gate for SMS. checkSend() answers: may this text go out right now?
// Pure function of its arguments: no clock, no storage, no network, never throws.
//
// Rules, in the order they are checked (first match holds the text):
//   invalid-input       input is malformed, so nothing can be verified (fail closed)
//   opted-out           customer replied STOP (any text, marketing or transactional)
//   no-consent          marketing without opt-in
//   no-valid-time-zone  marketing, customer's local time cannot be determined
//   quiet-hours         marketing outside 8:00 a.m. to 9:00 p.m. customer-local
//                       (47 CFR 64.1200(c)(1))
//   no-opt-out-notice   marketing text lacks STOP opt-out instructions (CTIA)

const KINDS = new Set(["marketing", "transactional"]);

// Quiet hours: marketing is allowed from 08:00:00 up to, not including, 21:00:00 local.
const FIRST_ALLOWED_HOUR = 8;
const FIRST_HELD_HOUR = 21;

// A "transactional" text that also advertises is a marketing text under the FCC rules.
const PROMO_PATTERNS = [
  /\d+\s*%\s*off\b/i,
  /\$\s*\d+(\.\d+)?\s*off\b/i,
  /\b(discount|coupon|promo(tion(al)?)?|promo code|voucher)\b/i,
  /\b(use|enter|apply) (code|coupon)\b/i,
  /\b(shop|buy|order) now\b/i,
  /\blimited[- ]time\b/i,
  /\bflash sale\b/i,
  /\b(special|exclusive) (offer|deal)\b/i,
  /\bfree (gift|shipping on your next)\b/i,
];

const OPT_OUT_NOTICE = /\bSTOP\b/i;

const hold = (rule) => ({ allowed: false, rule });
const allow = () => ({ allowed: true, rule: "" });

function isValidDate(d) {
  return Object.prototype.toString.call(d) === "[object Date]" && Number.isFinite(d.getTime());
}

// Returns an IANA name Intl accepts, or null. Rejects values that cannot be a real
// customer location: bare abbreviations ("EST" has no daylight saving), "UTC"/"GMT"
// and Etc/* (usually a server default, not where the customer is).
function usableTimeZone(tz) {
  if (typeof tz !== "string") return null;
  const name = tz.trim();
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(name)) return null;
  if (/^etc\//i.test(name)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return null;
  }
}

function localHour(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return Number.isInteger(hour) ? hour % 24 : null;
}

export async function checkSend(args) {
  try {
    const { user, message, now } = args;
    if (!isValidDate(now)) return hold("invalid-input");
    if (!user || typeof user !== "object") return hold("invalid-input");
    if (!message || typeof message !== "object") return hold("invalid-input");
    if (!KINDS.has(message.kind)) return hold("invalid-input");
    if (typeof message.text !== "string" || message.text.trim() === "") return hold("invalid-input");
    const sms = user.sms;
    if (!sms || typeof sms !== "object") return hold("invalid-input");

    // STOP is a revocation of consent. Only null/undefined means "never opted out";
    // any other value (even an unparseable string) is treated as opted out.
    if (sms.optedOutAt !== null && sms.optedOutAt !== undefined) return hold("opted-out");

    const text = message.text;
    const isMarketing =
      message.kind === "marketing" || PROMO_PATTERNS.some((re) => re.test(text));

    // Transactional texts rest on the customer's own request or order, so they do not
    // need the marketing opt-in, quiet hours or STOP footer.
    if (!isMarketing) return allow();

    if (sms.optedIn !== true) return hold("no-consent");

    const tz = usableTimeZone(user.timeZone);
    if (!tz) return hold("no-valid-time-zone");
    const hour = localHour(now, tz);
    if (hour === null) return hold("no-valid-time-zone");
    if (hour < FIRST_ALLOWED_HOUR || hour >= FIRST_HELD_HOUR) return hold("quiet-hours");

    if (!OPT_OUT_NOTICE.test(text)) return hold("no-opt-out-notice");

    return allow();
  } catch {
    return hold("invalid-input");
  }
}
