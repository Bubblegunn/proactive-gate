// SMS send gate. Returns { allowed, rule }; rule is "" when allowed.
// Rules (each reason has one fixed identifier):
//   invalid-input, invalid-now, invalid-kind, empty-text  - malformed arguments
//   opted-out        - customer replied STOP (blocks every kind of text)
//   no-consent       - marketing text without SMS opt-in
//   missing-opt-out  - marketing text lacks STOP opt-out instructions
//   unknown-timezone - marketing text, profile time zone missing/invalid
//   quiet-hours      - marketing text outside 8:00-21:00 local time
//                      (47 CFR 64.1200(c)(1))

const QUIET_START_HOUR = 8; // first allowed hour, local
const QUIET_END_HOUR = 21; // first blocked hour in the evening, local

const hold = (rule) => ({ allowed: false, rule });
const OK = () => ({ allowed: true, rule: "" });

function localHour(now, timeZone) {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
  } catch {
    return null;
  }
}

export async function checkSend(args) {
  try {
    const { user, message, now } = args ?? {};
    if (!user || typeof user !== "object" || !message || typeof message !== "object") {
      return hold("invalid-input");
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return hold("invalid-now");

    const kind = message.kind;
    if (kind !== "marketing" && kind !== "transactional") return hold("invalid-kind");
    const text = message.text;
    if (typeof text !== "string" || text.trim() === "") return hold("empty-text");

    const sms = user.sms;
    if (!sms || typeof sms !== "object") return hold("no-consent");

    // STOP applies to all texts from us, not only marketing. Any non-empty
    // optedOutAt counts, even if unparseable or in the future (fail closed).
    const out = sms.optedOutAt;
    if (out !== null && out !== undefined && out !== "") return hold("opted-out");

    if (kind === "transactional") return OK();

    // Marketing from here on.
    if (sms.optedIn !== true) return hold("no-consent");
    if (!/\bSTOP\b/i.test(text)) return hold("missing-opt-out");

    const hour = localHour(now, user.timeZone);
    if (hour === null) return hold("unknown-timezone");
    if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return hold("quiet-hours");

    return OK();
  } catch {
    return hold("invalid-input");
  }
}
