const EU = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB".split(" "));
const get = (h, n) => { for (const k of Object.keys(h || {})) if (k.toLowerCase() === n.toLowerCase()) return String(h[k]); return ""; };
export function evaluateEmail({ message, recipient }) {
  if (message.kind === "transactional") return { allowed: true, rule: "transactional" };
  if (["unsubscribed", "complained", "hard_bounce"].includes(recipient.status)) return { allowed: false, rule: "suppressed_" + recipient.status };
  if (EU.has(String(recipient.country).toUpperCase()) && recipient.marketingConsent !== true) return { allowed: false, rule: "eu_uk_consent_required" };
  if (!/<https:\/\/[^>]+>/i.test(get(message.headers, "List-Unsubscribe"))) return { allowed: false, rule: "missing_list_unsubscribe" };
  if (!/List-Unsubscribe=One-Click/i.test(get(message.headers, "List-Unsubscribe-Post"))) return { allowed: false, rule: "missing_one_click" };
  if (!message.postalAddress || !String(message.postalAddress).trim()) return { allowed: false, rule: "missing_postal_address" };
  return { allowed: true, rule: "ok" };
}
