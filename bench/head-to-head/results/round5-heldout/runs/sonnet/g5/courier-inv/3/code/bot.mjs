// WhatsApp Business Platform (Cloud API) send gate.
//
// Rules:
//  1. No send without the patient's WhatsApp opt-in.
//  2. A template message may be sent to an opted-in patient at any time.
//  3. A free-form text message may only be sent inside the 24-hour customer
//     service window, which starts at the patient's most recent inbound message.
//
// The webhook `timestamp` is a Unix time in SECONDS (a string), not milliseconds.

const WINDOW_SECONDS = 24 * 60 * 60;
// Tolerated difference between Meta's clock and ours for a timestamp "in the future".
const CLOCK_SKEW_SECONDS = 5 * 60;

const deny = (reason) => ({ allowed: false, reason });
const allow = () => ({ allowed: true, reason: null });

export function decideWhatsApp(message, now) {
  const contact = message?.contact;
  if (contact === null || typeof contact !== "object") return deny("invalid_message");

  if (contact.optedIn !== true) return deny("not_opted_in");

  if (message.type === "template") return allow();
  if (message.type !== "text") return deny("unsupported_message_type");

  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw)) return deny("invalid_timestamp");

  const nowSeconds = now.getTime() / 1000;
  if (!Number.isFinite(nowSeconds)) return deny("invalid_clock");

  const elapsed = nowSeconds - Number(raw);
  if (elapsed < -CLOCK_SKEW_SECONDS) return deny("invalid_timestamp");
  if (elapsed >= WINDOW_SECONDS) return deny("service_window_closed");
  return allow();
}
