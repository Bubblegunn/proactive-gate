import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createGate, MemoryStore } from "../src/index.js";
import { explain } from "../src/index.js";
import { loadFixtures } from "../src/conformance.js";
import { createMcpServer, decisionToJson, TOOLS } from "../src/mcp.js";
import type { Gate } from "../src/gate.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = `${root}dist/src/cli.js`;
const info = { name: "proactive-gate", version: "test" };
const request = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const tool = (id: number, name: string, args: unknown) => request(id, "tools/call", { name, arguments: args });

type ToolResponse = { result: { structuredContent: Record<string, unknown>; content: Array<{ text: string }>; isError?: boolean } };

test("initialize negotiates a protocol version and advertises tools", async () => {
  const handle = createMcpServer(createGate({ checks: [] }), info);
  const known = (await handle(request(1, "initialize", { protocolVersion: "2025-03-26" }))) as { result: { protocolVersion: string; capabilities: unknown; serverInfo: unknown } };
  assert.equal(known.result.protocolVersion, "2025-03-26");
  assert.deepEqual(known.result.capabilities, { tools: {} });
  assert.deepEqual(known.result.serverInfo, info);
  const unknown = (await handle(request(2, "initialize", { protocolVersion: "1999-01-01" }))) as { result: { protocolVersion: string } };
  assert.equal(unknown.result.protocolVersion, "2025-06-18");
});

test("tools/list names decide and explain, and only explain claims to be read-only", async () => {
  const handle = createMcpServer(createGate({ checks: [] }), info);
  const listed = (await handle(request(1, "tools/list"))) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
  assert.deepEqual(listed.result.tools.map((t) => t.name), ["decide", "explain"]);
  assert.deepEqual(listed.result.tools.map((t) => t.annotations.readOnlyHint), [false, true]);
  assert.equal(TOOLS.length, 2);
});

test("a notification gets no reply, an unknown method an error, a malformed request an error", async () => {
  const handle = createMcpServer(createGate({ checks: [] }), info);
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const missing = (await handle(request(7, "resources/list"))) as { error: { code: number } };
  assert.equal(missing.error.code, -32601);
  const bad = (await handle({ id: 8, method: "tools/list" })) as { error: { code: number } };
  assert.equal(bad.error.code, -32600);
  const unknownTool = (await handle(tool(9, "send", {}))) as { error: { code: number; message: string } };
  assert.equal(unknownTool.error.code, -32602);
  assert.match(unknownTool.error.message, /known tools: decide, explain/);
});

test("bad arguments come back as a tool error the model can read, not a protocol error", async () => {
  const handle = createMcpServer(createGate({ checks: [] }), info);
  for (const args of [{}, { user: { id: "u" }, candidate: { id: "c", type: "t" } }, { user: { id: "u", consent: true }, candidate: { id: "c", type: "t" }, now: "yesterday" }]) {
    const response = (await handle(tool(1, "decide", args))) as ToolResponse;
    assert.equal(response.result.isError, true, JSON.stringify(args));
    assert.equal(typeof response.result.structuredContent.error, "string");
  }
});

// The same fixtures the library is held to, asked through the tool instead of the function.
const fixtures = await loadFixtures(`${root}spec/fixtures`);
for (const fixture of fixtures) {
  test(`mcp decide agrees with the library: ${fixture.name}`, async () => {
    const viaLibrary = async () => {
      const store = new MemoryStore();
      for (const [key, value] of Object.entries(fixture.store_seed ?? {})) await store.set((fixture.policy.keyPrefix ?? "pg:") + key, value);
      return createGate({ policy: fixture.policy, store });
    };
    const library = await viaLibrary();
    const handle = createMcpServer(await viaLibrary(), info);
    for (const [i, t] of fixture.tests.entries()) {
      const input = { user: t.input.user, candidate: t.input.candidate, now: new Date(t.input.now), ...(t.input.flags ? { flags: t.input.flags } : {}) };
      const decision = await library.evaluate(input);
      const expected = decisionToJson(decision);
      if (t.commit) await library.commit(decision, input);
      const response = (await handle(tool(i, "decide", { user: t.input.user, candidate: t.input.candidate, now: t.input.now, ...(t.input.flags ? { flags: t.input.flags } : {}), ...(t.commit ? { commit: true } : {}) }))) as ToolResponse;
      const got = response.result.structuredContent;
      assert.equal(got.allowed, t.expect.allowed, `${t.description}: allowed`);
      assert.equal(got.rejectedBy, t.expect.rejectedBy, `${t.description}: rejectedBy`);
      assert.equal(got.nextAllowedAt, "nextAllowedAt" in t.expect ? (t.expect.nextAllowedAt ?? undefined) : expected.nextAllowedAt, `${t.description}: nextAllowedAt`);
      // Same decision except the per-evaluation id, which carries a sequence number.
      // `committed` only exists on the tool side.
      const { committed: _committed, ...rest } = got;
      assert.deepEqual({ ...rest, id: 0 }, { ...expected, id: 0 }, t.description);
      assert.equal(response.result.content[0]!.text, JSON.stringify(got), "content mirrors structuredContent");
      if (t.commit && t.expect.commit !== undefined && t.expect.allowed) assert.equal(got.committed, t.expect.commit, `${t.description}: committed`);
    }
  });
}

test("commit true consumes the budget and commit false does not", async () => {
  const policy = { specVersion: "1.0.0", checks: [{ id: "consent" }, { id: "dailyBudget", limit: 1 }] };
  const handle = createMcpServer(createGate({ policy, store: new MemoryStore() }), info);
  const args = (commit?: boolean) => ({ user: { id: "u1", consent: true }, candidate: { id: "c1", type: "reminder" }, now: "2026-09-04T09:00:00Z", ...(commit === undefined ? {} : { commit }) });
  const peek = (await handle(tool(1, "decide", args()))) as ToolResponse;
  assert.equal(peek.result.structuredContent.allowed, true);
  assert.equal("committed" in peek.result.structuredContent, false);
  const again = (await handle(tool(2, "decide", args(false)))) as ToolResponse;
  assert.equal(again.result.structuredContent.allowed, true, "evaluating twice without commit spends nothing");
  const spend = (await handle(tool(3, "decide", args(true)))) as ToolResponse;
  assert.equal(spend.result.structuredContent.committed, true);
  const after = (await handle(tool(4, "decide", args()))) as ToolResponse;
  assert.equal(after.result.structuredContent.allowed, false);
  assert.equal(after.result.structuredContent.rejectedBy, "dailyBudget");
  assert.equal(after.result.structuredContent.nextAllowedAt, "2026-09-05T00:00:00.000Z", "no time zone: the budget resets at the next UTC midnight");
});

test("explain returns the library's sentences and never consumes a budget", async () => {
  const policy = { specVersion: "1.0.0", checks: [{ id: "consent" }, { id: "quietHours" }, { id: "dailyBudget", limit: 1 }] };
  const store = new MemoryStore();
  const gate = createGate({ policy, store });
  const handle = createMcpServer(gate, info);
  const user = { id: "u1", consent: true, timezone: "Europe/Istanbul", quietHours: { start: "22:00", end: "08:00" } };
  const now = "2026-09-04T20:30:00Z";
  const response = (await handle(tool(1, "explain", { user, candidate: { id: "c1", type: "reminder" }, now, commit: true }))) as ToolResponse;
  const sentences = explain(await gate.evaluate({ user, candidate: { id: "c1", type: "reminder" }, now: new Date(now) }));
  assert.equal(response.result.structuredContent.summary, sentences.summary);
  assert.deepEqual(response.result.structuredContent.checks, sentences.checks);
  assert.equal(await store.get("pg:budget:u1:2026-09-04"), null);
});

test("over stdio: one JSON message per line in, one per line out, the process ends when input does", async () => {
  const child = spawn(process.execPath, [cli, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const lines = [
    JSON.stringify(request(1, "initialize", { protocolVersion: "2025-06-18" })),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    "not json",
    JSON.stringify(tool(2, "decide", { user: { id: "u1", consent: false }, candidate: { id: "c1", type: "reminder" }, now: "2026-09-04T09:00:00Z" })),
  ];
  child.stdin.end(`${lines.join("\n")}\n`);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, err);
  const replies = out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(replies.length, 3, "the notification gets no reply");
  assert.equal(replies[0].id, 1);
  assert.equal(replies[1].error.code, -32700);
  assert.equal(replies[2].result.structuredContent.rejectedBy, "consent");
});

test("a hostile client gets protocol errors or readable tool errors, never a crash", async () => {
  const handle = createMcpServer(createGate({ checks: [] }), info);
  // A request without an id is a notification: no reply, and no throw.
  assert.equal(await handle({ jsonrpc: "2.0", method: "tools/call", params: { name: "explain", arguments: {} } }), null);
  // A message that is not an object, or has no JSON-RPC version, is an invalid request.
  for (const message of [42, null, [], "decide", { id: 3, method: "tools/list" }]) {
    const reply = (await handle(message)) as { error: { code: number } };
    assert.equal(reply.error.code, -32600, JSON.stringify(message));
  }
  // params of the wrong shape: the tool name is empty, so it is an unknown tool.
  const badParams = (await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: "decide" })) as { error: { code: number } };
  assert.equal(badParams.error.code, -32602);
  // arguments of the wrong shape: a readable tool error.
  const badArgs = (await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "decide", arguments: "x" } })) as ToolResponse;
  assert.equal(badArgs.result.isError, true);
  assert.match(String(badArgs.result.structuredContent.error), /user must be an object/);
  // commit sent to explain is ignored: a readable result, and no budget is spent.
  const policy = { specVersion: "1.0.0", checks: [{ id: "consent" }, { id: "dailyBudget", limit: 1 }] };
  const store = new MemoryStore();
  const hostile = createMcpServer(createGate({ policy, store }), info);
  const args = { user: { id: "u1", consent: true }, candidate: { id: "c1", type: "reminder" }, now: "2026-09-04T09:00:00Z", commit: true };
  const explained = (await hostile(tool(6, "explain", args))) as ToolResponse;
  assert.equal(explained.result.isError, undefined);
  assert.equal(await store.get("pg:budget:u1:2026-09-04"), null);
});

test("a commit that loses the race for the last budget unit is a refusal, not an allowance", async () => {
  const policy = { specVersion: "1.0.0", checks: [{ id: "consent" }, { id: "dailyBudget", limit: 1 }] };
  const store = new MemoryStore();
  const gate = createGate({ policy, store });
  const input = { user: { id: "u1", consent: true }, candidate: { id: "c1", type: "reminder" }, now: new Date("2026-09-04T09:00:00Z") };
  // A second worker evaluates and commits between this call's evaluate and its commit, taking the last unit.
  const racing: Gate = {
    ...gate,
    commit: async (decision, at) => {
      const rival = await gate.evaluate(input);
      await gate.commit(rival, input);
      return gate.commit(decision, at);
    },
  };
  const handle = createMcpServer(racing, info);
  const response = (await handle(tool(1, "decide", { user: input.user, candidate: input.candidate, now: "2026-09-04T09:00:00Z", commit: true }))) as ToolResponse;
  assert.equal(response.result.structuredContent.allowed, false);
  assert.equal(response.result.structuredContent.rejectedBy, "commit");
  assert.equal(response.result.structuredContent.committed, false);
  assert.equal(response.result.structuredContent.reason, "a budget was exhausted at commit");
});
