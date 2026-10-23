export function evaluateEmail({ message, recipient }) {
  if (["unsubscribed", "complained", "hard_bounce"].includes(recipient.status)) return { allowed: false, rule: "suppressed_" + recipient.status };
  const h = message.headers || {};
  if (!h["List-Unsubscribe"]) return { allowed: false, rule: "missing_list_unsubscribe" };
  if (!/One-Click/.test(h["List-Unsubscribe-Post"] || "")) return { allowed: false, rule: "missing_one_click" };
  if (!(message.postalAddress && message.postalAddress.trim())) return { allowed: false, rule: "missing_postal_address" };
  return { allowed: true, rule: "ok" };
}
