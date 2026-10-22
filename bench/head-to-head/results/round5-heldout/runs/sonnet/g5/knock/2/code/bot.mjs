// WhatsApp Business Platform (Cloud API) pre-send gate.
//
// Rules:
// 1. Every business-initiated or reply message needs the patient's opt-in.
// 2. Templates may be sent at any time (to an opted-in contact).
// 3. Free-form text may only be sent inside the 24-hour customer service
//    window, which opens when the patient sends us a message.
//
// The webhook `timestamp` is Unix time in SECONDS (UTC), delivered as a string.

const WINDOW_MS = 24 * 60 * 60 * 1000;
// Tolerated difference between Meta's clock and ours for timestamps slightly ahead of `now`.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const deny = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  const type = message?.type;
  if (type !== "text" && type !== "template") return deny("invalid_message_type");

  // Opt-in must be exactly true; missing or truthy-but-not-true values do not count.
  if (message.contact?.optedIn !== true) return deny("not_opted_in");

  if (type === "template") return { allowed: true, reason: null };

  const raw = message.contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");

  // Meta sends epoch seconds as a decimal string. Reject anything else
  // (milliseconds-looking values, ISO dates, empty strings, decimals, negatives).
  if (typeof raw !== "string" || !/^\d{1,11}$/.test(raw)) {
    return deny("invalid_inbound_timestamp");
  }
  const inboundMs = Number(raw) * 1000;

  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) return deny("invalid_now");

  const elapsed = nowMs - inboundMs;
  if (elapsed < -CLOCK_SKEW_MS) return deny("invalid_inbound_timestamp");
  if (elapsed >= WINDOW_MS) return deny("window_closed");

  return { allowed: true, reason: null };
}
