#!/usr/bin/env node
/**
 * proactive-gate replay <events.jsonl> [--policy <module>] [--json]
 *
 * Replays candidate messages through a gate and prints why each one was or
 * was not allowed. Each JSONL line is an EvaluateInput: { user, candidate, now? }.
 * The policy module must export `gate` (a Gate) or default-export one; without
 * --policy the default check order runs against an in-memory store.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createGate } from "./gate.js";
import { defaultChecks } from "./checks.js";
import type { Gate } from "./gate.js";
import type { Decision, EvaluateInput } from "./types.js";

const HELP = `usage: proactive-gate replay <events.jsonl> [--policy <module.js>] [--json] [--commit]

Replays candidates through a gate and reports what was allowed and why not.

  --policy <module>  ES module exporting \`gate\` (or default) built with createGate()
  --json             one Decision per line instead of the summary table
  --commit           also call gate.commit() for allowed decisions, so the daily
                     budget is consumed in order, as it would be in production
  -h, --help         this text

Each line of the file is {"user": {...}, "candidate": {...}, "now": "ISO date"}.`;

export async function loadPolicy(path?: string): Promise<Gate> {
  if (!path) return createGate({ checks: defaultChecks() });
  const mod = await import(pathToFileURL(resolve(path)).href);
  const gate = mod.gate ?? mod.default;
  if (!gate || typeof gate.evaluate !== "function") throw new Error(`${path} must export a gate created with createGate()`);
  return gate as Gate;
}

export async function replay(lines: string[], gate: Gate, commit: boolean): Promise<Decision[]> {
  const decisions: Decision[] = [];
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    let input: EvaluateInput;
    try {
      const raw = JSON.parse(line);
      input = { ...raw, ...(raw.now ? { now: new Date(raw.now) } : {}) };
    } catch (error) {
      throw new Error(`line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const decision = await gate.evaluate(input);
    if (commit && decision.allowed) {
      const ok = await gate.commit(decision, input);
      if (!ok) {
        decision.allowed = false;
        decision.rejectedBy = "dailyBudget";
        decision.reason = "daily budget exhausted at commit";
      }
    }
    decisions.push(decision);
  }
  return decisions;
}

export function summarize(decisions: Decision[]): string {
  const allowed = decisions.filter((d) => d.allowed).length;
  const byCheck = new Map<string, number>();
  const sample = new Map<string, string>();
  for (const d of decisions) {
    if (d.allowed || !d.rejectedBy) continue;
    byCheck.set(d.rejectedBy, (byCheck.get(d.rejectedBy) ?? 0) + 1);
    if (!sample.has(d.rejectedBy) && d.reason) sample.set(d.rejectedBy, d.reason);
  }
  const deferred = decisions.filter((d) => d.allowed && d.deliverAt).length;
  const lines = [
    `${decisions.length} candidates  ·  ${allowed} allowed (${pct(allowed, decisions.length)})  ·  ${decisions.length - allowed} rejected${deferred ? `  ·  ${deferred} deferred to a later moment` : ""}`,
    "",
  ];
  if (byCheck.size) {
    const w = Math.max(...[...byCheck.keys()].map((k) => k.length), 5);
    lines.push(`${"check".padEnd(w)}  ${"rejected".padStart(8)}  example`);
    lines.push("-".repeat(w + 2 + 8 + 2 + 40));
    for (const [id, n] of [...byCheck.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`${id.padEnd(w)}  ${String(n).padStart(8)}  ${sample.get(id) ?? ""}`);
    }
  } else {
    lines.push("nothing was rejected");
  }
  return lines.join("\n");
}

const pct = (n: number, total: number) => (total ? `${((100 * n) / total).toFixed(1)}%` : "0%");

async function main(argv: string[]) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  const [command, file] = argv;
  if (command !== "replay" || !file) {
    console.error(HELP);
    process.exit(2);
  }
  const policyIndex = argv.indexOf("--policy");
  const policy = policyIndex >= 0 ? argv[policyIndex + 1] : undefined;
  const gate = await loadPolicy(policy);
  const text = await readFile(file, "utf8");
  const decisions = await replay(text.split("\n"), gate, argv.includes("--commit"));
  if (argv.includes("--json")) {
    for (const d of decisions) console.log(JSON.stringify(d));
  } else {
    console.log(summarize(decisions));
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry === import.meta.url || entry.endsWith("/proactive-gate")) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
