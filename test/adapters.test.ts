import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createGate, checks } from "../src/index.js";
import { gateToolApproval } from "../src/adapters/ai-sdk.js";
import { gateProcessor } from "../src/adapters/mastra.js";
import { gateMiddleware } from "../src/adapters/langchain.js";
import { gateToolInputGuardrail } from "../src/adapters/openai-agents.js";
import { hookDecision } from "../src/cli.js";
import type { EvaluateInput } from "../src/index.js";

const now = new Date("2026-09-04T09:00:00Z");
const ok: EvaluateInput = { user: { id: "u1", consent: true }, candidate: { id: "c1", type: "reminder" }, now };
const no: EvaluateInput = { user: { id: "u2", consent: false }, candidate: { id: "c2", type: "reminder" }, now };
const gate = () => createGate({ checks: [checks.consent(), checks.dailyBudget({ limit: 1 })] });

test("ai-sdk tool approval denies with the gate's reason and approves otherwise", async () => {
  const approve = gateToolApproval({ gate: gate(), toInput: (call: { input: EvaluateInput }) => call.input });
  assert.deepEqual(await approve({ input: no }), { approved: false, reason: "rejected by consent: user has not consented to proactive behaviour" });
  assert.deepEqual(await approve({ input: ok }), { approved: true });
  assert.equal((await approve({ input: { ...ok, candidate: { id: "c3", type: "reminder" } } })).approved, false, "budget consumed by the first approval");
});

test("mastra processor aborts on reject and returns messages on allow", async () => {
  const processor = gateProcessor<string>({ gate: gate(), toInput: ({ messages }) => (messages[0] === "no" ? no : ok) });
  const abort = (reason?: string): never => { throw new Error(reason); };
  await assert.rejects(processor.processOutputResult({ messages: ["no"], abort }), /rejected by consent/);
  assert.deepEqual(await processor.processOutputResult({ messages: ["hi"], abort }), ["hi"]);
});

test("langchain middleware refuses watched tools and passes others through", async () => {
  const mw = gateMiddleware<{ toolCall: { name: string; id?: string; args: { gate: EvaluateInput } } }, string>({ gate: gate(), tools: ["send_message"], toInput: (r) => r.toolCall.args.gate });
  const handler = async () => "sent";
  const refused = await mw.wrapToolCall({ toolCall: { name: "send_message", id: "t1", args: { gate: no } } }, handler);
  assert.deepEqual(refused, { type: "tool", content: "proactive-gate: rejected by consent: user has not consented to proactive behaviour", tool_call_id: "t1", status: "error" });
  assert.equal(await mw.wrapToolCall({ toolCall: { name: "send_message", args: { gate: ok } } }, handler), "sent");
  assert.equal(await mw.wrapToolCall({ toolCall: { name: "search", args: { gate: no } } }, handler), "sent");
});

test("openai-agents guardrail trips on reject", async () => {
  const guard = gateToolInputGuardrail<{ gate: EvaluateInput }>({ gate: gate(), toInput: ({ input }) => input.gate });
  assert.equal((await guard.execute({ input: { gate: no } })).tripwireTriggered, true);
  const allowed = await guard.execute({ input: { gate: ok } });
  assert.equal(allowed.tripwireTriggered, false);
  assert.deepEqual(allowed.outputInfo.surfaces, ["feed"]);
});

test("hook: PreToolUse JSON for the matching tool, nothing for others", async () => {
  const g = gate();
  const deny = await hookDecision({ tool_name: "send_message", tool_input: { gate: { user: no.user, candidate: no.candidate, now: now.toISOString() } } }, g, "send_message");
  assert.deepEqual(JSON.parse(deny!), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "proactive-gate: rejected by consent (user has not consented to proactive behaviour)" } });
  const allow = await hookDecision({ tool_name: "send_message", tool_input: { gate: { user: ok.user, candidate: ok.candidate } } }, g, "send_message");
  assert.equal(JSON.parse(allow!).hookSpecificOutput.permissionDecision, "allow");
  assert.equal(await hookDecision({ tool_name: "search" }, g, "send_message"), null);
  assert.match(JSON.parse((await hookDecision({ tool_name: "send_message", tool_input: {} }, g, "send_message"))!).hookSpecificOutput.permissionDecisionReason, /must carry/);
});

test("hook via the binary reads stdin and prints a decision", async () => {
  const event = JSON.stringify({ tool_name: "send_message", tool_input: { gate: { user: { id: "u1", consent: true, timezone: "Europe/Istanbul" }, candidate: { id: "c1", type: "reminder" }, now: "2026-09-04T09:00:00Z" } } });
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/src/cli.js", "hook", "--policy", "examples/policy.json"], { stdio: ["pipe", "pipe", "inherit"] });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.on("close", (code) => (code === 0 ? resolve(text) : reject(new Error(`exit ${code}`))));
    child.stdin.end(event);
  });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "allow");
});
