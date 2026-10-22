// WhatsApp Business Platform (Cloud API) pre-send gate.
//
// Rules:
// 1. Every business message needs the patient's opt-in.
// 2. Free-form ("text") messages are only allowed inside the 24-hour customer
//    service window, which starts at the patient's last inbound message.
// 3. Template messages may be sent outside the window (opt-in still required).
//
// The webhook `timestamp` is Unix time in SECONDS (string), not milliseconds.

const WINDOW_SECONDS = 24 * 60 * 60;
// Tolerated difference between Meta's clock and ours for a timestamp that
// appears to be in the future.
const CLOCK_SKEW_SECONDS = 5 * 60;

const deny = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  const type = message?.type;
  const contact = message?.contact;

  if (type !== "text" && type !== "template") return deny("unknown_message_type");
  if (!contact || contact.optedIn !== true) return deny("no_opt_in");

  if (type === "template") return { allowed: true, reason: null };

  // type === "text": needs an open 24-hour window.
  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw)) return deny("invalid_inbound_timestamp");

  const nowSeconds = now.getTime() / 1000;
  if (!Number.isFinite(nowSeconds)) return deny("invalid_clock");

  const age = nowSeconds - Number(raw);
  if (age < -CLOCK_SKEW_SECONDS) return deny("invalid_inbound_timestamp");
  if (age >= WINDOW_SECONDS) return deny("outside_24h_window");

  return { allowed: true, reason: null };
}
