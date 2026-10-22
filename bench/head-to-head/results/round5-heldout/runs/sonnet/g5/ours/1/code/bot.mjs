// WhatsApp Business Platform (Cloud API) send gate.
//
// Rules applied, in this order:
//  1. The patient must have opted in to WhatsApp messages (any message type).
//  2. A "template" message may be sent at any time once opted in.
//  3. A "text" (free-form) message is only allowed inside the 24-hour customer
//     service window, which opens when the patient last wrote to us. Outside it
//     Meta rejects the send (error 131047), so we stop it here.
//
// The webhook `timestamp` is a Unix time in SECONDS (UTC), delivered as a string.
// It is not milliseconds, so it must not be passed to `new Date()` unscaled.

const WINDOW_SECONDS = 24 * 60 * 60;
// Tolerated difference between Meta's clock and ours for a timestamp that is ahead of `now`.
const CLOCK_SKEW_SECONDS = 5 * 60;

const deny = (reason) => ({ allowed: false, reason });
const allow = () => ({ allowed: true, reason: null });

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  if (message === null || typeof message !== "object") return deny("invalid_message");

  const { type, contact } = message;
  if (type !== "text" && type !== "template") return deny("unsupported_message_type");
  if (contact === null || typeof contact !== "object") return deny("invalid_message");

  // Strict: only a real boolean true counts as consent.
  if (contact.optedIn !== true) return deny("not_opted_in");

  if (type === "template") return allow();

  const ts = contact.lastInboundTimestamp;
  if (ts === null || ts === undefined) return deny("no_inbound_message");
  if (typeof ts !== "string" || !/^\d{1,15}$/.test(ts.trim())) return deny("invalid_inbound_timestamp");

  const inboundSeconds = Number(ts.trim());
  const elapsed = Math.floor(now.getTime() / 1000) - inboundSeconds;
  if (elapsed < -CLOCK_SKEW_SECONDS) return deny("invalid_inbound_timestamp"); // in the future
  if (elapsed >= WINDOW_SECONDS) return deny("customer_service_window_closed");

  return allow();
}
