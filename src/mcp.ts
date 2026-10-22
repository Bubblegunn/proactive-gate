/**
 * A Model Context Protocol server over stdio, with no dependency: newline-delimited JSON-RPC 2.0,
 * the three methods a tool server needs (initialize, tools/list, tools/call) and ping.
 *
 *   proactive-gate mcp --policy policy.json
 *
 * It exposes two tools over one gate, built from the policy file at start-up:
 *
 *   decide   evaluate { user, candidate, now? }; with commit true, also consume the budgets
 *   explain  the same evaluation, as one sentence per check; never consumes anything
 *
 * This file is not imported by the package's main entry, so the library stays free of Node
 * built-ins and of any MCP SDK.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { explain } from "./explain.js";
import type { Gate } from "./gate.js";
import type { Decision, EvaluateInput } from "./types.js";

export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Request { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
export interface Response { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

const iso = (d: Date | undefined): string | undefined => d?.toISOString();

/** A decision as plain JSON: instants as ISO strings, the per-check timings left out. */
export function decisionToJson(d: Decision): Record<string, Json> {
  const out: Record<string, Json> = {
    id: d.id,
    allowed: d.allowed,
    userId: d.userId,
    candidateId: d.candidateId,
    surfaces: d.surfaces,
    shadowed: d.shadowed,
    nearLimit: d.nearLimit,
    trace: d.trace.map((t) => ({ id: t.id, outcome: t.outcome, ...(t.reason ? { reason: t.reason } : {}), ...(t.shadow ? { shadow: true } : {}) })),
    evaluatedAt: d.evaluatedAt.toISOString(),
  };
  for (const [key, value] of [
    ["rejectedBy", d.rejectedBy], ["deferredBy", d.deferredBy], ["reason", d.reason],
    ["retryAt", iso(d.retryAt)], ["nextAllowedAt", iso(d.nextAllowedAt)], ["deliverAt", iso(d.deliverAt)],
  ] as const) if (value !== undefined) out[key] = value;
  return out;
}

const object = (description: string): Json => ({ type: "object", description, additionalProperties: true });

const INPUT_SCHEMA: Json = {
  type: "object",
  required: ["user", "candidate"],
  properties: {
    user: { ...(object("The person: id and consent are required; timezone, quietHours, snoozedUntil, mutedTypes, intensity and the rest are read by the checks that need them.") as object), required: ["id", "consent"] },
    candidate: { ...(object("The message the agent wants to send: id and type are required; priority, surfaces, channel and dedupeKey are optional.") as object), required: ["id", "type"] },
    now: { type: "string", description: "The instant to decide at, ISO 8601 ending in Z. Default: the current time." },
    flags: { type: "object", additionalProperties: { type: "boolean" }, description: "Operations flags. A killSwitch entry with a flag rejects while its flag is false." },
  },
};

export const TOOLS = [
  {
    name: "decide",
    title: "Decide whether to send",
    description: "Ask the gate whether a proactive message may reach this user now. Returns allowed, the check that refused and why, and nextAllowedAt, the earliest time that check would stop refusing. Budgets are only consumed when commit is true; call it with commit true right before sending, once per message.",
    inputSchema: { ...(INPUT_SCHEMA as object), properties: { ...((INPUT_SCHEMA as { properties: object }).properties), commit: { type: "boolean", description: "When the decision is allowed, consume the budgets. Default false." } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "explain",
    title: "Explain a decision",
    description: "Evaluate the same input and return the decision as plain sentences: one summary and one sentence per check that ran. Never consumes a budget.",
    inputSchema: INPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;

const asObject = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
};

function parseInput(args: Record<string, unknown>): EvaluateInput {
  const user = asObject(args.user, "user");
  const candidate = asObject(args.candidate, "candidate");
  if (typeof user.id !== "string" || typeof user.consent !== "boolean") throw new Error("user needs an id (string) and consent (boolean)");
  if (typeof candidate.id !== "string" || typeof candidate.type !== "string") throw new Error("candidate needs an id and a type (strings)");
  let now: Date | undefined;
  if (args.now !== undefined) {
    now = new Date(String(args.now));
    if (Number.isNaN(now.getTime())) throw new Error(`now "${String(args.now)}" is not an ISO 8601 instant`);
  }
  let flags: Record<string, boolean> | undefined;
  if (args.flags !== undefined) {
    const raw = asObject(args.flags, "flags");
    for (const [name, value] of Object.entries(raw)) if (typeof value !== "boolean") throw new Error(`flags.${name} must be a boolean`);
    flags = raw as Record<string, boolean>;
  }
  return { user: user as unknown as EvaluateInput["user"], candidate: candidate as unknown as EvaluateInput["candidate"], ...(now ? { now } : {}), ...(flags ? { flags } : {}) };
}

/** The server as a function from one request to its response, or null for a notification. Exported so tests need no process. */
export function createMcpServer(gate: Gate, info: { name: string; version: string }) {
  const toolResult = (value: Record<string, Json>, isError = false) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    try {
      const input = parseInput(args);
      const decision = await gate.evaluate(input);
      if (name === "explain") return toolResult({ decision: decisionToJson(decision), ...(explain(decision) as unknown as Record<string, Json>) });
      if (args.commit !== true || !decision.allowed) return toolResult(decisionToJson(decision));
      const committed = await gate.commit(decision, { ...input, now: decision.evaluatedAt });
      if (!committed) {
        // A concurrent delivery took the last unit between evaluate and commit: refuse, as replay does.
        decision.allowed = false;
        decision.rejectedBy = "commit";
        decision.reason = "a budget was exhausted at commit";
      }
      return toolResult({ ...decisionToJson(decision), committed });
    } catch (error) {
      return toolResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  };

  return async function handle(message: unknown): Promise<Response | null> {
    const request = message as Request;
    const id = request && typeof request === "object" && "id" in request ? (request.id ?? null) : undefined;
    const reply = (result: unknown): Response | null => (id === undefined ? null : { jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string): Response | null => (id === undefined ? null : { jsonrpc: "2.0", id, error: { code, message: text } });
    if (!request || typeof request !== "object" || request.jsonrpc !== "2.0" || typeof request.method !== "string") return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "not a JSON-RPC 2.0 request" } };
    switch (request.method) {
      case "initialize": {
        const asked = String(request.params?.protocolVersion ?? "");
        const protocolVersion = (SUPPORTED_PROTOCOLS as readonly string[]).includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
        return reply({ protocolVersion, capabilities: { tools: {} }, serverInfo: info, instructions: "Call decide before sending any proactive message to a person. If allowed is true, send it, and pass commit true on that call so the budgets are consumed. If allowed is false, do not send; when nextAllowedAt is present, ask again then." });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": {
        const name = String(request.params?.name ?? "");
        if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool "${name}"; known tools: ${TOOLS.map((t) => t.name).join(", ")}`);
        return reply(await call(name, (request.params?.arguments ?? {}) as Record<string, unknown>));
      }
      default:
        return request.method.startsWith("notifications/") ? null : fail(-32601, `method not found: ${request.method}`);
    }
  };
}

/** Reads one JSON-RPC message per line from `input` and writes one response per line to `output`. Resolves when input ends. */
export async function serveStdio(gate: Gate, info: { name: string; version: string }, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const handle = createMcpServer(gate, info);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response: Response | null;
    try {
      response = await handle(JSON.parse(line));
    } catch (error) {
      response = error instanceof SyntaxError ? { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } } : { jsonrpc: "2.0", id: null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
    }
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
