// WhatsApp Business Platform (Cloud API) pre-send gate.
//
// Rules:
//  1. The patient must have opted in to WhatsApp messages (all message types).
//  2. A "template" message may be sent at any time (once opted in).
//  3. A "text" (free-form) message may only be sent inside the 24-hour customer
//     service window, which starts at the patient's last inbound message.
//
// Meta's webhook `timestamp` is a Unix time in SECONDS (UTC), delivered as a string.

const WINDOW_SECONDS = 24 * 60 * 60;
// Tolerated clock difference between Meta's clock and ours for timestamps slightly in the future.
const CLOCK_SKEW_SECONDS = 5 * 60;

const deny = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  const type = message?.type;
  if (type !== "text" && type !== "template") return deny("invalid_message_type");

  const contact = message.contact;
  if (contact?.optedIn !== true) return deny("no_opt_in");

  if (type === "template") return { allowed: true, reason: null };

  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw)) return deny("invalid_inbound_timestamp");

  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) return deny("invalid_clock");

  const ageSeconds = nowMs / 1000 - Number(raw); // raw is seconds, not milliseconds
  if (ageSeconds < -CLOCK_SKEW_SECONDS) return deny("invalid_inbound_timestamp");
  if (ageSeconds >= WINDOW_SECONDS) return deny("outside_service_window");

  return { allowed: true, reason: null };
}
