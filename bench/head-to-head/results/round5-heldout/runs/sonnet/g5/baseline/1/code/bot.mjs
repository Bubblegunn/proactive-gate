// Pre-send gate for WhatsApp Business Platform (Cloud API) messages.
//
// Rules, checked in this order:
//  1. The patient must have opted in to WhatsApp messages (any message type).
//  2. A template message may be sent at any time once rule 1 passes.
//  3. A free-form text message may be sent only inside the 24-hour customer
//     service window, which starts at the patient's last inbound message.
//
// The webhook `timestamp` is a UNIX time in SECONDS (UTC), delivered as a string.

const WINDOW_MS = 24 * 60 * 60 * 1000;
// Tolerated difference between Meta's clock and ours for a timestamp "in the future".
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const deny = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) return deny("invalid_clock");

  if (message === null || typeof message !== "object") return deny("invalid_message");
  const { type, contact } = message;
  if (type !== "text" && type !== "template") return deny("invalid_type");
  if (contact === null || typeof contact !== "object") return deny("invalid_message");

  if (contact.optedIn !== true) return deny("not_opted_in");

  if (type === "template") return { allowed: true, reason: null };

  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return deny("invalid_timestamp");

  const inboundMs = Number(raw) * 1000; // seconds -> milliseconds
  if (!Number.isSafeInteger(inboundMs)) return deny("invalid_timestamp");

  const ageMs = nowMs - inboundMs;
  if (ageMs < -CLOCK_SKEW_MS) return deny("invalid_timestamp"); // implausibly in the future (e.g. milliseconds)
  if (ageMs >= WINDOW_MS) return deny("window_expired");

  return { allowed: true, reason: null };
}
