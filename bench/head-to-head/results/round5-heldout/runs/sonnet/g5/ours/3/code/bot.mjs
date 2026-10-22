// WhatsApp Business Platform (Cloud API) pre-send gate.
//
// Rules:
// - Opt-in is required for every business-initiated message, text or template.
// - Free-form ("text") messages are only allowed inside the 24-hour customer
//   service window, which opens when the patient last messaged us.
// - Outside the window (or if the patient never wrote), only approved
//   templates may be sent.
// - The webhook `timestamp` is Unix time in SECONDS (UTC), delivered as a string.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const deny = (reason) => ({ allowed: false, reason });

function parseInboundMs(value) {
  if (typeof value !== "string" || !/^\d{1,12}$/.test(value.trim())) return null;
  return Number(value.trim()) * 1000;
}

export function decideWhatsApp(message, now) {
  const type = message?.type;
  const contact = message?.contact;

  if (type !== "text" && type !== "template") return deny("invalid_message_type");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_now");
  if (contact?.optedIn !== true) return deny("not_opted_in");

  if (type === "template") return { allowed: true, reason: null };

  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny("no_inbound_message");

  const inboundMs = parseInboundMs(raw);
  if (inboundMs === null) return deny("invalid_inbound_timestamp");

  const age = now.getTime() - inboundMs;
  if (age < -CLOCK_SKEW_MS) return deny("invalid_inbound_timestamp");
  if (age >= WINDOW_MS) return deny("service_window_closed");

  return { allowed: true, reason: null };
}
