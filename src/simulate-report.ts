/**
 * The simulation as a table. Rendering only: every number here was computed in simulate.ts,
 * and nothing in this file recounts anything, so the terminal output and `--json` cannot
 * disagree with each other.
 */
import { DEMO_WEEK_NOTE } from "./demo-week.js";
import type { SimResult, SimRun, SimTimelineRow } from "./simulate.js";

const VERDICT: Record<string, string> = {
  sent: "sent",
  held: "held",
  deferred: "deferred",
  expired: "expired",
  lostAtCommit: "lost at commit",
  spentNotDelivered: "spent, not delivered",
};

/** Outcome plus the check that produced it, which is the whole verdict in one cell. */
const verdictOf = (cell: { outcome: string; check?: string } | undefined): string => {
  if (!cell) return "";
  const word = VERDICT[cell.outcome] ?? cell.outcome;
  return cell.check && cell.outcome !== "sent" ? `${word} ${cell.check}` : word;
};

const pad = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s.padEnd(w));

/** The widest cell in a column, so nothing is truncated that would have fitted. */
const widthOf = (values: string[], min: number) => Math.max(min, ...values.map((v) => v.length));

function timelineTable(result: SimResult, rows: SimTimelineRow[], why: number | null): string[] {
  const labels = result.runs.map((r) => r.label);
  const cols = labels.map((label, i) => ({
    label,
    width: widthOf([label, ...rows.map((r) => verdictOf(r.cells[i]))], 8),
  }));
  const userW = widthOf(["user", ...rows.map((r) => r.userId)], 4);
  const typeW = widthOf(["type", ...rows.map((r) => r.type)], 4);
  const priW = widthOf(["pri", ...rows.map((r) => r.priority)], 3);
  const head = `${pad("when (local)", 13)}  ${pad("user", userW)}  ${pad("type", typeW)}  ${pad("pri", priW)}  ${cols.map((c) => pad(c.label, c.width)).join("  ")}`;
  const out = [head, "-".repeat(head.length)];
  for (const row of rows) {
    const cells = cols.map((c, i) => pad(verdictOf(row.cells[i]), c.width)).join("  ");
    out.push(`${pad(row.localTime, 13)}  ${pad(row.userId, userW)}  ${pad(row.type, typeW)}  ${pad(row.priority, priW)}  ${cells}`.trimEnd());
    // --why prints the sentence explain() already produces, under the row it belongs to.
    const cell = why === null ? undefined : row.cells[why];
    if (cell && cell.outcome !== "sent" && cell.sentence) out.push(`               ${cell.sentence}`);
  }
  return out;
}

function summaryTable(runs: SimRun[], night: { start: number; end: number }): string[] {
  const labels = runs.map((r) => r.label);
  const nightLabel = `delivered ${String(night.start).padStart(2, "0")}:00-${String(night.end).padStart(2, "0")}:00 local`;
  const quietLabel = "delivered inside their own quiet hours";
  const rows: Array<[string, string[]]> = [
    ["delivered", runs.map((r) => String(r.counts.sent))],
    ["held", runs.map((r) => String(r.counts.held))],
    ["deferred, then delivered", runs.map((r) => String(r.counts.sentAfterDeferral))],
    ["moved to a later moment", runs.map((r) => String(r.counts.sentAtALaterMoment))],
    ["deferred, then expired", runs.map((r) => String(r.counts.expired))],
    ["lost at commit", runs.map((r) => String(r.counts.lostAtCommit))],
    ["spent, not delivered", runs.map((r) => String(r.counts.spentNotDelivered))],
    [quietLabel, runs.map((r) => String(r.counts.sentInQuietHours))],
    ["  of those, critical (what the floor lets through)", runs.map((r) => String(r.counts.sentInQuietHoursByFloor))],
    [`${nightLabel} (a fixed window)`, runs.map((r) => String(r.counts.sentAtNight))],
    ["most one person got in a day", runs.map((r) => String(r.counts.busiestUserDay))],
  ];
  const labelW = widthOf(["", ...rows.map((r) => r[0])], 12);
  const colW = labels.map((l, i) => widthOf([l, ...rows.map((r) => r[1][i] ?? "")], 6));
  const out = [
    `${pad("", labelW)}  ${labels.map((l, i) => pad(l, colW[i] ?? 6)).join("  ")}`,
    "-".repeat(labelW + 2 + colW.reduce((n, w) => n + w + 2, 0)),
  ];
  for (const [label, values] of rows) {
    if (values.every((v) => v === "0")) continue;
    out.push(`${pad(label, labelW)}  ${values.map((v, i) => pad(v, colW[i] ?? 6)).join("  ")}`.trimEnd());
  }
  return out;
}

function stoppedTable(run: SimRun): string[] {
  if (!run.counts.stoppedBy.length) return [];
  const checkW = widthOf(["check", ...run.counts.stoppedBy.map((s) => s.check)], 5);
  const out = [
    `${pad("check", checkW)}  ${pad("stopped", 7)}  example`,
    "-".repeat(checkW + 2 + 7 + 2 + 40),
  ];
  for (const s of run.counts.stoppedBy) out.push(`${pad(s.check, checkW)}  ${String(s.count).padStart(7)}  ${s.example}`);
  return out;
}

export interface ReportOptions {
  /** How many timeline rows to print. 0 prints all of them. */
  limit?: number;
  /** Print only the candidates the policies disagreed about. */
  disagreementsOnly?: boolean;
  /** Print each held candidate's sentence under its row. */
  why?: boolean;
  /** Which run the sentences and the stopped-by table describe; the last policy by default. */
  reasonsFor?: number;
  night?: { start: number; end: number };
  /** Appended under the tables, for a generated stream that has to say so. */
  note?: string;
  /** One line per user, for a generated stream whose people were chosen for a reason. */
  people?: string[];
}

export function formatSimulation(result: SimResult, options: ReportOptions = {}): string {
  const limit = options.limit ?? 20;
  const night = options.night ?? { start: 22, end: 8 };
  const users = new Set(result.timeline.map((r) => r.userId)).size;
  const source = options.disagreementsOnly ? result.disagreements : result.timeline;
  const rows = limit > 0 ? source.slice(0, limit) : source;
  const reasonsFor = options.reasonsFor ?? result.runs.length - 1;

  const out: string[] = [
    `proactive-gate simulate  ·  seed ${result.seed}  ·  ${result.events} candidates, ${users} users`,
    `policies: ${result.runs.map((r) => r.label).join("  |  ")}`,
    "rows are in the order a server produced them; the time is the recipient's own clock",
    "",
    ...timelineTable(result, rows, options.why ? reasonsFor : null),
  ];
  if (rows.length < source.length) {
    out.push(
      `${source.length - rows.length} more ${options.disagreementsOnly ? "disagreements" : "candidates"} not shown; --limit 0 prints every row, --json prints everything`,
    );
  }
  out.push("", `the policies disagreed about ${result.disagreements.length} of ${result.events} candidates`, "");
  out.push(...summaryTable(result.runs, night));

  const subject = result.runs[reasonsFor];
  if (subject && subject.counts.stoppedBy.length) {
    out.push("", `why ${subject.label} did not send`, "");
    out.push(...stoppedTable(subject));
  }

  const budget = subject?.budget ?? [];
  if (budget.length) {
    const busiest = [...budget].sort((a, b) => b.used - a.used || a.userId.localeCompare(b.userId)).slice(0, 5);
    out.push("", `budget spent, read back out of the store (top ${busiest.length} of ${budget.length} user-days)`, "");
    for (const row of busiest) out.push(`  ${pad(row.userId, 10)} ${row.localDay}  ${row.used}`);
  }

  if (options.people?.length) {
    out.push("", "who is in the week, and why each one is here", "");
    for (const line of options.people) out.push(`  ${line}`);
  }
  if (options.note) out.push("", options.note);
  return out.join("\n");
}

export { DEMO_WEEK_NOTE };
