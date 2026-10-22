// Broken B for Z5 (stay quiet). Standalone; state kept in memory.
// Mistakes: (1) no thin-data threshold at all, so a 1-day account with 2 data points is shown; (2) silence is explained
// with the word "error" (reason "error: suppressed"); (3) surfaces always lists both places, ignoring hourStats.
// Expected failures: criterion 1 (thin data shown), 5 (reason contains "error"), 6 (push not excluded in a dismissed hour).
const dayFmt = new Map();
function localDay(zone, date) {
  if (!dayFmt.has(zone)) dayFmt.set(zone, new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }));
  return dayFmt.get(zone).format(date);
}
const shown = new Set();

export async function decide({ user, candidate, context, now }) {
  const insight = candidate.insight || {};
  if (context.crisis === true) return { send: false, surfaces: [], reason: "error: suppressed during crisis" };
  if (user.focusMode === true) return { send: false, surfaces: [], reason: "error: focus mode" };
  if (!(insight.confidence >= 0.5)) return { send: false, surfaces: [], reason: "error: low confidence" };
  const key = `${user.id}|${insight.key}|${localDay(user.timezone, now)}`;
  if (shown.has(key)) return { send: false, surfaces: [], reason: "error: already shown" };
  shown.add(key);
  return { send: true, surfaces: ["push", "inApp"], reason: null };
}
