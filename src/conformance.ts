/**
 * Runs the language-neutral fixtures under spec/fixtures against a gate. The
 * TypeScript test suite and `proactive-gate replay --fixtures` both use it.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createGate } from "./gate.js";
import { MemoryStore } from "./stores.js";
import type { Candidate, Decision, Policy, UserState } from "./types.js";

export interface FixtureExpect {
  allowed: boolean;
  rejectedBy?: string;
  deferredBy?: string;
  retryAt?: string;
  surfaces?: string[];
  deliverAt?: string;
  trace: string[];
  shadowed?: string[];
  nearLimit?: Array<{ check: string; used: number; limit: number }>;
  reason_pattern?: string;
  commit?: boolean;
  store_after?: Record<string, string>;
}

export interface FixtureTest {
  description: string;
  input: { user: UserState; candidate: Candidate; now: string };
  commit?: boolean;
  expect: FixtureExpect;
}

export interface Fixture {
  spec_version: string;
  since: string;
  name: string;
  description: string;
  policy: Policy;
  store_seed?: Record<string, string>;
  tests: FixtureTest[];
}

export async function loadFixtures(dir: string): Promise<Fixture[]> {
  const files: string[] = [];
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".json")) files.push(path);
    }
  };
  await walk(dir);
  files.sort();
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(f, "utf8")) as Fixture));
}

export async function readSkips(file: string): Promise<Map<string, string>> {
  const skips = new Map<string, string>();
  let text = "";
  try { text = await readFile(file, "utf8"); } catch { return skips; }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [name, ...reason] = trimmed.split("#");
    skips.set(name!.trim(), reason.join("#").trim());
  }
  return skips;
}

const iso = (d: Date | undefined) => (d ? d.toISOString() : undefined);

/** Runs one fixture and returns the list of mismatches, empty when it conforms. */
export async function runFixture(fixture: Fixture): Promise<string[]> {
  const failures: string[] = [];
  const store = new MemoryStore();
  const prefix = fixture.policy.keyPrefix ?? "pg:";
  for (const [key, value] of Object.entries(fixture.store_seed ?? {})) await store.set(prefix + key, value);
  const gate = createGate({ policy: fixture.policy, store });
  for (const [i, t] of fixture.tests.entries()) {
    const at = `${fixture.name} [${i}] ${t.description}`;
    const input = { user: t.input.user, candidate: t.input.candidate, now: new Date(t.input.now) };
    const decision: Decision = await gate.evaluate(input);
    const e = t.expect;
    const check = (field: string, actual: unknown, expected: unknown) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${at}: ${field} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    };
    check("allowed", decision.allowed, e.allowed);
    check("trace", decision.trace.map((x) => x.id), e.trace);
    check("rejectedBy", decision.rejectedBy, e.rejectedBy);
    check("deferredBy", decision.deferredBy, e.deferredBy);
    check("retryAt", iso(decision.retryAt), e.retryAt);
    if (e.surfaces) check("surfaces", decision.surfaces, e.surfaces);
    check("deliverAt", iso(decision.deliverAt), e.deliverAt);
    if (e.shadowed) check("shadowed", decision.shadowed, e.shadowed);
    if (e.nearLimit) check("nearLimit", decision.nearLimit, e.nearLimit);
    if (e.reason_pattern && !(decision.reason && new RegExp(e.reason_pattern).test(decision.reason))) failures.push(`${at}: reason ${JSON.stringify(decision.reason)} does not match /${e.reason_pattern}/`);
    if (t.commit) {
      const committed = await gate.commit(decision, input);
      if (e.commit !== undefined) check("commit", committed, e.commit);
    }
    for (const [key, value] of Object.entries(e.store_after ?? {})) check(`store ${key}`, await store.get(prefix + key), value);
  }
  return failures;
}
