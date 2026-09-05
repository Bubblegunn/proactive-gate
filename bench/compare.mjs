/**
 * Replays one committed day of candidate messages through the hand-rolled
 * policy in naive.mjs and through the gate built from fixtures/policy.json,
 * and prints where they disagree.
 *
 * Run: npm run bench:compare
 * Both runs are deterministic: the fixture carries its own `now` per line and
 * the gate uses an in-memory store, so the table below is reproducible.
 */
import { readFile } from "node:fs/promises";
import { createGate } from "proactive-gate";
import { createNaive } from "./naive.mjs";

const here = (p) => new URL(p, import.meta.url);

const policy = JSON.parse(await readFile(here("fixtures/policy.json"), "utf8"));
const lines = (await readFile(here("fixtures/day.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const limit = policy.checks.find((c) => c.id === "dailyBudget")?.limit ?? 2;

const gate = createGate({ policy });
// emre dismissed three insights in the past fortnight; the gate learned it, the
// hand-rolled policy has nowhere to put it.
for (const day of [14, 9, 3]) {
  await gate.record({ id: "emre" }, { type: "insight" }, "dismissed", new Date(Date.parse("2026-09-04T10:00:00Z") - day * 86400000));
}

const naive = createNaive({ limit });
const rows = [];

for (const line of lines) {
  const input = { user: line.user, candidate: line.candidate, now: new Date(line.now) };
  const decision = await gate.evaluate(input);
  if (decision.allowed) await gate.commit(decision, input);
  const n = await naive.allow(input);
  rows.push({
    id: line.candidate.id,
    user: line.user.id,
    gate: decision.allowed ? "sent" : "stopped",
    gateRule: decision.rejectedBy ?? decision.deferredBy ?? "",
    naive: n.allowed ? "sent" : "stopped",
    naiveRule: n.rule ?? "",
  });
}

const disagree = rows.filter((r) => r.gate !== r.naive);
const pad = (s, n) => String(s).padEnd(n);
const count = (rows, key, value) => rows.filter((r) => r[key] === value).length;

console.log(`${lines.length} candidates, one day, ${new Set(lines.map((l) => l.user.id)).size} users, daily limit ${limit}\n`);
console.log(`${pad("id", 4)}${pad("user", 7)}${pad("gate", 9)}${pad("why", 20)}${pad("hand-rolled", 13)}why`);
console.log("-".repeat(72));
for (const r of rows) {
  const mark = r.gate === r.naive ? " " : "*";
  console.log(`${mark}${pad(r.id, 3)}${pad(r.user, 7)}${pad(r.gate, 9)}${pad(r.gateRule, 20)}${pad(r.naive, 13)}${r.naiveRule}`);
}
console.log("-".repeat(72));
console.log(`gate:        ${count(rows, "gate", "sent")} sent, ${count(rows, "gate", "stopped")} stopped`);
console.log(`hand-rolled: ${count(rows, "naive", "sent")} sent, ${count(rows, "naive", "stopped")} stopped`);
console.log(`\n${disagree.length} disagreements (*), and none of them is a matter of taste:\n`);

const WHY = {
  a5: "a critical alert: the gate lets priority bypass the cap, the cap in the if statements does not",
  b1: "a two-day-old account: the gate holds normal messages back for a week, the if statements never knew",
  c1: "the user pressed snooze: the gate defers to when it ends, the if statements have no snooze",
  e1: "three dismissals of this type: the gate is silent for a week, the if statements do not track outcomes",
  f4: "01:00 in Tokyo, a new local day: the gate resets the cap, the UTC-day key stays on yesterday for nine more hours",
  g4: "18:00 in Los Angeles, still the same local day: the UTC-day key already rolled, so the cap pays out twice",
};
for (const r of disagree) console.log(`  ${r.id}  ${WHY[r.id] ?? `${r.gate} vs ${r.naive}`}`);
console.log("\nThe last two are the same bug in both directions: a user who is silenced\nfor part of their day, and a user who gets double the messages they agreed to.");
