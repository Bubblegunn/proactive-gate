// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { RedisStore } from "../dist/src/stores.js";
import { storeContract } from "../dist/src/store-contract.js";

const url = process.env.PROACTIVE_GATE_REDIS_URL;
const unset = "PROACTIVE_GATE_REDIS_URL is not set";
const loadRedis = async () => (await import("ioredis")).Redis;

/**
 * An in-memory stand-in for a Redis server, used where no server is available. `eval` runs the
 * script's two steps under one call, which is what Redis guarantees for a script; the separate
 * `expire` command fails, standing in for a dropped connection or a crashed process between two
 * round trips.
 * @param {{ withEval: boolean }} options
 */
function faultyClient({ withEval }) {
  /** @type {Map<string, { value: string, ttl: number }>} */
  const data = new Map();
  const calls = /** @type {string[]} */ ([]);
  const incr = (/** @type {string} */ key) => {
    const entry = data.get(key) ?? { value: "0", ttl: -1 };
    entry.value = String(Number(entry.value) + 1);
    data.set(key, entry);
    return Number(entry.value);
  };
  const client = {
    data,
    calls,
    async get(/** @type {string} */ key) {
      calls.push("get");
      return data.get(key)?.value ?? null;
    },
    async set(/** @type {string} */ key, /** @type {string} */ value) {
      calls.push("set");
      data.set(key, { value, ttl: -1 });
      return "OK";
    },
    async incr(/** @type {string} */ key) {
      calls.push("incr");
      return incr(key);
    },
    async expire() {
      calls.push("expire");
      throw new Error("connection lost before EXPIRE");
    },
    async del(/** @type {string} */ key) {
      calls.push("del");
      data.delete(key);
      return 1;
    },
  };
  if (withEval)
    Object.assign(client, {
      async eval(
        /** @type {string} */ _script,
        /** @type {number} */ _numKeys,
        /** @type {string} */ key,
        /** @type {string | number} */ ttl,
      ) {
        calls.push("eval");
        const next = incr(key);
        if (next === 1 && Number(ttl) > 0) data.get(key).ttl = Number(ttl);
        return next;
      },
    });
  return client;
}

test("RedisStore: a failure between INCR and EXPIRE cannot leave a counter with no TTL", async () => {
  const client = faultyClient({ withEval: true });
  const store = new RedisStore(client);
  // Whether incr resolves or rejects, the key must not be left alive with no expiry.
  await store.incr("budget:u1", 60).catch(() => undefined);
  const entry = client.data.get("budget:u1");
  assert.ok(
    entry === undefined || entry.ttl > 0,
    `counter left with no TTL after calls ${client.calls.join(", ")}`,
  );
  assert.deepEqual(client.calls, ["eval"], "incr should be one round trip");
});

test("RedisStore: a client without eval keeps working through INCR then EXPIRE", async () => {
  const data = new Map();
  const store = new RedisStore({
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); return "OK"; },
    async incr(key) { const n = Number(data.get(key) ?? 0) + 1; data.set(key, String(n)); return n; },
    async expire() { return 1; },
    async del(key) { data.delete(key); return 1; },
  });
  assert.equal(await store.incr("k", 60), 1);
  assert.equal(await store.incr("k", 60), 2);
});

let prefixNumber = 0;

storeContract(
  "RedisStore (real server)",
  async () => {
    if (!url) throw new Error(unset);
    const Redis = await loadRedis();
    const keyPrefix = `pg-contract:${process.pid}:${++prefixNumber}:`;
    const client = new Redis(url, { keyPrefix });
    return {
      store: new RedisStore(client),
      teardown: async () => {
        // keyPrefix is not applied to SCAN patterns or to the keys SCAN returns, so cleanup uses
        // a client without one. Only this run's keys are removed; nothing is flushed.
        const raw = new Redis(url);
        const keys = await raw.keys(`${keyPrefix}*`);
        if (keys.length) await raw.del(...keys);
        raw.disconnect();
        client.disconnect();
      },
    };
  },
  // A server's clock cannot be injected, so the boundary cases are reported as skipped.
  { expiry: "skip", skip: url ? undefined : unset },
);

test(
  "RedisStore (real server): EXPIRE failing after INCR leaves no counter without a TTL",
  { skip: url ? undefined : unset },
  async () => {
    const Redis = await loadRedis();
    const client = new Redis(url);
    const key = `pg-atomic:${process.pid}:${Date.now()}`;
    try {
      // The real client, with EXPIRE made to fail the way a dropped connection would.
      const faulty = new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === "expire")
            return async () => {
              throw new Error("connection lost before EXPIRE");
            };
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await new RedisStore(faulty).incr(key, 60).catch(() => undefined);
      const ttl = await client.ttl(key);
      assert.ok(ttl === -2 || ttl > 0, `TTL is ${ttl}; -1 means the counter never expires`);
    } finally {
      await client.del(key);
      client.disconnect();
    }
  },
);
