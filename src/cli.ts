#!/usr/bin/env node
/**
 * proactive-gate replay <events.jsonl> [--policy <file>] [--json] [--commit]
 * proactive-gate replay --fixtures <dir>
 * proactive-gate hook --policy <file> [--tool <name>]
 *
 * replay feeds candidate messages through a gate and prints why each one was or
 * was not allowed. Each JSONL line is an EvaluateInput: { user, candidate, now? }.
 * A policy is a JSON document (spec/schema/policy.schema.json) or an ES module
 * that exports `gate`; without --policy the default check order runs against an
 * in-memory store. --fixtures runs the conformance suite instead.
 *
 * hook reads a Claude Code PreToolUse event on stdin and prints a permission
 * decision for the matching tool.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createGate } from "./gate.js";
import { defaultChecks } from "./checks.js";
import { loadFixtures, readSkips, runFixture } from "./conformance.js";
import { FRAMEWORKS, listText, plan } from "./init.js";
import type { Framework } from "./init.js";
import type { Gate } from "./gate.js";
import type { Decision, EvaluateInput, Policy } from "./types.js";

const HELP = `usage: proactive-gate init [--preset <name>] [--framework <name>] [--out <file>]
       proactive-gate replay <events.jsonl> [--policy <file>] [--json] [--commit]
       proactive-gate replay --fixtures <dir> [--skip <file>]
       proactive-gate hook --policy <file> [--tool <name>]

init writes a policy you can read and edit, and prints the lines that wire it in.

  --preset <name>    a platform or legal preset to append (see --list)
  --framework <name> ${FRAMEWORKS.join(", ")} (default none)
  --out <file>       where to write (default proactive-gate.policy.json)
  --force            overwrite an existing file
  --list             print the presets and frameworks and exit

replay reports what was allowed and why not.

  --policy <file>    policy.json (spec/schema/policy.schema.json) or an ES module
                     exporting \`gate\` (or default) built with createGate()
  --json             one Decision per line instead of the summary table
  --commit           also call gate.commit() for allowed decisions, so budgets are
                     consumed in order, as they would be in production
  --fixtures <dir>   run the conformance fixtures under <dir> and report failures
  --skip <file>      fixture names to skip, one per line (default spec/skip/ts.txt)

hook reads a PreToolUse event (JSON) on stdin; when tool_name matches --tool
(default send_message) it evaluates tool_input.gate = { user, candidate, now? }
and prints a permissionDecision. Other tools print nothing.

  -h, --help         this text
  --version          print the version

Each line of an events file is {"user": {...}, "candidate": {...}, "now": "ISO date"}.`;

export async function loadPolicy(path?: string): Promise<Gate> {
  if (!path) return createGate({ checks: defaultChecks() });
  if (path.endsWith(".json")) {
    const policy = JSON.parse(await readFile(path, "utf8")) as Policy;
    return createGate({ policy });
  }
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
        decision.rejectedBy = "commit";
        decision.reason = "a budget was exhausted at commit";
      }
    }
    decisions.push(decision);
  }
  return decisions;
}

export function summarize(decisions: Decision[]): string {
  const allowed = decisions.filter((d) => d.allowed).length;
  const deferred = decisions.filter((d) => d.deferredBy).length;
  const byCheck = new Map<string, number>();
  const sample = new Map<string, string>();
  for (const d of decisions) {
    const by = d.rejectedBy ?? d.deferredBy;
    if (d.allowed || !by) continue;
    byCheck.set(by, (byCheck.get(by) ?? 0) + 1);
    if (!sample.has(by) && d.reason) sample.set(by, d.reason);
  }
  const later = decisions.filter((d) => d.allowed && d.deliverAt).length;
  const shadowed = decisions.reduce((n, d) => n + d.shadowed.length, 0);
  const lines = [
    `${decisions.length} candidates  ·  ${allowed} allowed (${pct(allowed, decisions.length)})  ·  ${decisions.length - allowed - deferred} rejected${deferred ? `  ·  ${deferred} deferred` : ""}${later ? `  ·  ${later} moved to a later moment` : ""}${shadowed ? `  ·  ${shadowed} shadow rejections` : ""}`,
    "",
  ];
  if (byCheck.size) {
    const w = Math.max(...[...byCheck.keys()].map((k) => k.length), 5);
    lines.push(`${"check".padEnd(w)}  ${"stopped".padStart(8)}  example`);
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

const argValue = (argv: string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function runFixtures(dir: string, skipFile: string | undefined): Promise<number> {
  const fixtures = await loadFixtures(dir);
  const skips = await readSkips(skipFile ?? resolve(dir, "..", "skip", "ts.txt"));
  let failed = 0;
  let skipped = 0;
  for (const fixture of fixtures) {
    const reason = skips.get(fixture.name);
    if (reason !== undefined) {
      skipped++;
      console.log(`skip  ${fixture.name}  (${reason})`);
      continue;
    }
    const failures = await runFixture(fixture);
    if (failures.length) {
      failed++;
      console.log(`FAIL  ${fixture.name}`);
      for (const f of failures) console.log(`      ${f}`);
    } else {
      console.log(`ok    ${fixture.name}`);
    }
  }
  console.log(`${fixtures.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
  return failed ? 1 : 0;
}

interface PreToolUseEvent {
  tool_name?: string;
  tool_input?: { gate?: { user: EvaluateInput["user"]; candidate: EvaluateInput["candidate"]; now?: string } };
}

/** Turns a PreToolUse event into the hook output Claude Code expects, or null when the tool does not match. */
export async function hookDecision(event: PreToolUseEvent, gate: Gate, tool: string): Promise<string | null> {
  if (event.tool_name !== tool) return null;
  const payload = event.tool_input?.gate;
  const out = (permissionDecision: "allow" | "deny", permissionDecisionReason: string) =>
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } });
  if (!payload?.user || !payload.candidate) return out("deny", "tool_input.gate must carry { user, candidate } for proactive-gate to decide");
  const decision = await gate.evaluate({ user: payload.user, candidate: payload.candidate, ...(payload.now ? { now: new Date(payload.now) } : {}) });
  if (decision.allowed) {
    const ok = await gate.commit(decision, { user: payload.user, candidate: payload.candidate, ...(decision.evaluatedAt ? { now: decision.evaluatedAt } : {}) });
    return ok ? out("allow", `proactive-gate: allowed on ${decision.surfaces.join(",")}${decision.deliverAt ? `, deliver at ${decision.deliverAt.toISOString()}` : ""}`) : out("deny", "proactive-gate: a budget was exhausted at commit");
  }
  if (decision.deferredBy) return out("deny", `proactive-gate: deferred by ${decision.deferredBy} until ${decision.retryAt?.toISOString()} (${decision.reason})`);
  return out("deny", `proactive-gate: rejected by ${decision.rejectedBy} (${decision.reason})`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const VERSION = createRequire(import.meta.url)("../../package.json").version as string;

async function main(argv: string[]) {
  if (argv.includes("--version")) {
    console.log(VERSION);
    return;
  }
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  const [command, file] = argv;
  if (command === "init") {
    if (argv.includes("--list")) {
      console.log(listText());
      return;
    }
    const out = argValue(argv, "--out") ?? "proactive-gate.policy.json";
    const presetName = argValue(argv, "--preset");
    const frameworkName = argValue(argv, "--framework");
    const { policy, message } = plan({
      ...(presetName === undefined ? {} : { preset: presetName }),
      ...(frameworkName === undefined ? {} : { framework: frameworkName as Framework }),
      out,
    });
    if (!argv.includes("--force") && existsSync(out)) {
      console.error(`${out} already exists; pass --force to overwrite it`);
      process.exit(1);
    }
    await writeFile(out, policy);
    console.log(message);
    return;
  }
  if (command === "hook") {
    const gate = await loadPolicy(argValue(argv, "--policy"));
    const event = JSON.parse((await readStdin()) || "{}") as PreToolUseEvent;
    const output = await hookDecision(event, gate, argValue(argv, "--tool") ?? "send_message");
    if (output) console.log(output);
    return;
  }
  if (command !== "replay") {
    console.error(HELP);
    process.exit(2);
  }
  const fixtures = argValue(argv, "--fixtures");
  if (fixtures) {
    process.exit(await runFixtures(fixtures, argValue(argv, "--skip")));
  }
  if (!file || file.startsWith("--")) {
    console.error(HELP);
    process.exit(2);
  }
  const gate = await loadPolicy(argValue(argv, "--policy"));
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
