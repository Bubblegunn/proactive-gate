// WhatsApp Business Platform (Cloud API) pre-send gate.
//
// Rules:
// 1. No opt-in, no message of any kind.
// 2. A free-form "text" message is only allowed inside the 24-hour customer
//    service window, which starts at the patient's last inbound message.
//    Outside the window (or with no inbound message) Meta rejects it
//    (error 131047), so only a template can be sent.
// 3. A "template" message is allowed at any time for an opted-in contact.
//
// The webhook `timestamp` is a string of Unix time in SECONDS (UTC), not
// milliseconds.

const WINDOW_SECONDS = 24 * 60 * 60;
// Tolerated difference between Meta's clock and ours for a timestamp that
// appears to be in the future.
const CLOCK_SKEW_SECONDS = 5 * 60;

const deny = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  if (message == null || typeof message !== "object") return deny("invalid_message");
  const { type, contact } = message;

  if (type !== "text" && type !== "template") return deny("invalid_message_type");
  if (contact == null || typeof contact !== "object") return deny("invalid_contact");

  // Opt-in must be exactly true; anything else is treated as no consent.
  if (contact.optedIn !== true) return deny("not_opted_in");

  if (type === "template") return { allowed: true, reason: null };

  // type === "text": needs an open customer service window.
  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");
  if (typeof raw !== "string" || !/^\d{1,12}$/.test(raw)) {
    return deny("invalid_inbound_timestamp");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_now");

  const nowSeconds = now.getTime() / 1000;
  const age = nowSeconds - Number(raw);
  if (age < -CLOCK_SKEW_SECONDS) return deny("invalid_inbound_timestamp");
  if (age >= WINDOW_SECONDS) return deny("outside_24h_window");

  return { allowed: true, reason: null };
}
