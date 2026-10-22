// WhatsApp Business Platform (Cloud API) send gate.
//
// Rules:
// 1. No send without the patient's opt-in (optedIn must be exactly true).
// 2. A free-form "text" message is only allowed inside the 24-hour customer
//    service window, which opens when the patient last messaged us.
// 3. A "template" message may be sent outside the window (opt-in still required).
//
// Meta's webhook `timestamp` is a Unix time in SECONDS (string), not milliseconds.

const WINDOW_SECONDS = 24 * 60 * 60;
// Tolerated difference between Meta's clock and ours for a timestamp slightly in the future.
const CLOCK_SKEW_SECONDS = 5 * 60;

const deny = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_now");
  if (message === null || typeof message !== "object") return deny("invalid_message");

  const { type, contact } = message;
  if (type !== "text" && type !== "template") return deny("invalid_message_type");
  if (contact === null || typeof contact !== "object") return deny("invalid_contact");

  if (contact.optedIn !== true) return deny("not_opted_in");

  if (type === "template") return { allowed: true, reason: null };

  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");

  const str = typeof raw === "number" ? String(raw) : raw;
  if (typeof str !== "string" || !/^\d+$/.test(str.trim())) return deny("invalid_timestamp");
  const inboundSeconds = Number(str.trim());
  if (!Number.isSafeInteger(inboundSeconds)) return deny("invalid_timestamp");

  const ageSeconds = now.getTime() / 1000 - inboundSeconds;
  if (ageSeconds < -CLOCK_SKEW_SECONDS) return deny("invalid_timestamp");
  if (ageSeconds >= WINDOW_SECONDS) return deny("outside_24h_window");

  return { allowed: true, reason: null };
}
