// Broken A for Z5 (stay quiet). Standalone; state kept in memory.
// Mistakes: (1) the crisis flag is never read, so a crisis does not silence anything; (2) the same insight key is shown
// again on the same day (no record of what was shown); (3) focusMode is ignored.
// Expected failures: criterion 3 (second same-key send), criterion 4 (crisis candidates are shown).
// Known gap: criterion 2 as frozen uses focusMode true with confidence 0.42, which the confidence threshold silences anyway,
// so mistake (3) cannot fail criterion 2 on its own. That gap is recorded in the report, not papered over here.
export async function decide({ user, candidate, context, now }) {
  const insight = candidate.insight || {};
  if (user.accountAgeDays < 3 || insight.dataPoints < 5) {
    return { send: false, surfaces: [], reason: "There is not enough history yet to show this insight." };
  }
  if (!(insight.confidence >= 0.5)) {
    return { send: false, surfaces: [], reason: "The insight is not certain enough to show." };
  }
  const stats = context.hourStats[String(Number(new Intl.DateTimeFormat("en-US", { timeZone: user.timezone, hour: "2-digit", hourCycle: "h23" }).format(now)))];
  const pushOk = !stats || stats.acted >= stats.dismissed;
  return { send: true, surfaces: pushOk ? ["push", "inApp"] : ["inApp"], reason: null };
}
