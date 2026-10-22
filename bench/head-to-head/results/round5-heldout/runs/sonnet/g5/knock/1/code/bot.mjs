// WhatsApp Business Platform (Cloud API) pre-send gate.
//
// Rules:
// 1. Opt-in is required for every business-initiated message, text or template.
// 2. Free-form ("text") messages are only allowed inside the 24-hour customer
//    service window, which starts at the patient's most recent inbound message.
// 3. Template messages may be sent outside the window (opt-in still required).
//
// The webhook `timestamp` is a Unix time in SECONDS (UTC), delivered as a string.

const WINDOW_SECONDS = 24 * 60 * 60;
// Tolerated difference between our clock and Meta's, for timestamps slightly in the future.
const CLOCK_SKEW_SECONDS = 5 * 60;

const deny = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  if (message === null || typeof message !== "object") return deny("invalid_message");
  const { type, contact } = message;

  if (type !== "text" && type !== "template") return deny("invalid_type");
  if (contact === null || typeof contact !== "object") return deny("invalid_contact");

  // Strict: only a literal true counts as consent.
  if (contact.optedIn !== true) return deny("not_opted_in");

  if (type === "template") return { allowed: true, reason: null };

  // type === "text": needs an open 24-hour window.
  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw.trim())) return deny("invalid_timestamp");

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_now");

  const inboundSeconds = Number(raw.trim());
  const nowSeconds = now.getTime() / 1000;
  const elapsed = nowSeconds - inboundSeconds;

  if (elapsed < -CLOCK_SKEW_SECONDS) return deny("invalid_timestamp");
  if (elapsed >= WINDOW_SECONDS) return deny("window_expired");

  return { allowed: true, reason: null };
}
