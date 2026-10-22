const set = new Set();
const norm = (e) => String(e).trim().toLowerCase();
export async function unsubscribe(email) { set.add(norm(email)); }
export async function resubscribe(email) { set.delete(norm(email)); }
export async function mayEmail(email, kind, now) {
  if (kind === "marketing" && set.has(norm(email))) return { allowed: false, reason: "Recipient has unsubscribed" };
  return { allowed: true, reason: "ok" };
}
