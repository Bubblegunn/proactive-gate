#!/usr/bin/env node
/**
 * The Mastra adapter, run without Mastra.
 *
 * In an agent, the gate is one output processor:
 *
 *   import { gateProcessor } from "proactive-gate/mastra";
 *   new Agent({ ..., outputProcessors: [gateProcessor({ gate, toInput: () => ({ user, candidate }) })] })
 *
 * Mastra calls processOutputResult({ messages, abort }) with the agent's output before it
 * reaches the user; the processor asks the gate, and on a rejection calls abort(reason),
 * which stops the result. This script makes that same call itself for a day of candidate
 * messages in day.jsonl, with the clock taken from each line, so it runs offline and prints
 * the same thing every time.
 *
 *   node examples/mastra/run.mjs
 */
import { readFileSync } from "node:fs";
import { createGate, MemoryStore } from "proactive-gate";
import { gateProcessor } from "proactive-gate/mastra";

const here = (name) => new URL(name, import.meta.url);
const policy = JSON.parse(readFileSync(here("policy.json"), "utf8"));
const day = readFileSync(here("day.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

const gate = createGate({ policy, store: new MemoryStore() });

// Mastra's abort() throws inside the framework; here a small error class stands in for it.
class Aborted extends Error {}
const abort = (reason) => { throw new Aborted(reason ?? "aborted"); };

let sent = 0;
for (const event of day) {
  const input = { user: event.user, candidate: event.candidate, now: new Date(event.now) };
  const processor = gateProcessor({ gate, toInput: () => input });
  const messages = [{ role: "assistant", content: [{ type: "text", text: event.text }] }];
  try {
    await processor.processOutputResult({ messages, abort });
    sent += 1;
    console.log(`send    ${event.candidate.id}  ${event.text}`);
  } catch (error) {
    if (!(error instanceof Aborted)) throw error;
    console.log(`stopped ${event.candidate.id}  ${error.message}`);
  }
}
console.log(`\n${day.length} candidates, ${sent} sent, ${day.length - sent} stopped by the processor`);
