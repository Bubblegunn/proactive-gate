import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./stores.js";
import type { Store } from "./types.js";

export interface StoreContractHandle {
  store: Store;
  teardown?: () => void | Promise<void>;
}

export type StoreContractFactory = (clock?: () => number) => Store | StoreContractHandle | Promise<Store | StoreContractHandle>;

export interface StoreContractOptions {
  expiry?: "injected" | "skip";
  skip?: string;
}

function asHandle(value: Store | StoreContractHandle): StoreContractHandle {
  return "store" in value ? value : { store: value };
}

export function storeContract(name: string, factory: StoreContractFactory, options: StoreContractOptions = {}): void {
  const expiry = options.expiry ?? "injected";
  const skip = options.skip;
  const testOptions = skip ? { skip } : {};
  const expiryOptions = expiry === "skip" ? { skip: "expiry cases skipped: this store does not accept an injected clock" } : testOptions;

  const withStore = async <T>(clock: (() => number) | undefined, run: (store: Store) => Promise<T>): Promise<T> => {
    const handle = asHandle(await factory(clock));
    try {
      return await run(handle.store);
    } finally {
      await handle.teardown?.();
    }
  };

  test(`${name}: get, set and del`, testOptions, async () => {
    await withStore(undefined, async (store) => {
      assert.equal(await store.get("missing"), null);
      await store.set("key", "value");
      assert.equal(await store.get("key"), "value");
      await store.del("key");
      assert.equal(await store.get("key"), null);
    });
  });

  test(`${name}: incr from absent starts at one`, testOptions, async () => {
    await withStore(undefined, async (store) => {
      assert.equal(await store.incr("counter"), 1);
      assert.equal(await store.incr("counter"), 2);
    });
  });

  test(`${name}: incr is atomic`, testOptions, async () => {
    await withStore(undefined, async (store) => {
      const results = await Promise.all(Array.from({ length: 100 }, () => store.incr("counter")));
      assert.deepEqual([...results].sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i + 1));
      assert.equal(await store.get("counter"), "100");
    });
  });

  test(`${name}: set and incr TTLs expire at the same boundary`, expiryOptions, async () => {
    let now = 0;
    const clock = () => now;
    await withStore(clock, async (store) => {
      await store.set("set", "value", 2);
      await store.incr("incr", 2);
      now = 1999;
      assert.equal(await store.get("set"), "value");
      assert.equal(await store.get("incr"), "1");
      now = 2000;
      assert.equal(await store.get("set"), null);
      assert.equal(await store.get("incr"), null);
    });
  });

  test(`${name}: expiry is inclusive at the boundary`, expiryOptions, async () => {
    let now = 1000;
    const clock = () => now;
    await withStore(clock, async (store) => {
      await store.set("key", "value", 1);
      assert.equal(await store.get("key"), "value");
      now = 1999;
      assert.equal(await store.get("key"), "value");
      now = 2000;
      assert.equal(await store.get("key"), null);
    });
  });

  test(`${name}: random operations match MemoryStore`, testOptions, async () => {
    for (let seed = 1; seed <= 40; seed++) {
      let now = 0;
      const clock = () => now;
      await withStore(expiry === "injected" ? clock : undefined, async (store) => {
        const reference = new MemoryStore(clock);
        const keys = ["a", "b", "c"];
        let state = 0x6d2b79f5 ^ seed;
        const random = () => {
          state = (Math.imul(state ^ (state >>> 16), 2246822507) + 3266489909) >>> 0;
          return state / 4294967296;
        };
        try {
          for (let step = 0; step < 40; step++) {
            const key = keys[Math.floor(random() * keys.length)]!;
            const ttl = expiry === "injected" && random() > 0.5 ? 1 + Math.floor(random() * 3) : undefined;
            const op = Math.floor(random() * 5);
            if (op === 0) {
              const value = String(Math.floor(random() * 100));
              await reference.set(key, value, ttl);
              await store.set(key, value, ttl);
            } else if (op === 1) {
              assert.equal(await store.incr(key, ttl), await reference.incr(key, ttl), `seed ${seed} step ${step}: incr disagreed`);
            } else if (op === 2) {
              await reference.del(key);
              await store.del(key);
            } else if (op === 3) {
              if (expiry === "injected") now += Math.floor(random() * 3000);
            } else {
              assert.equal(await store.get(key), await reference.get(key), `seed ${seed} step ${step}: get disagreed on ${key}`);
            }
          }
          for (const key of keys) {
            assert.equal(await store.get(key), await reference.get(key), `seed ${seed}: final state disagreed on ${key}`);
          }
        } finally {
          await reference.del("a");
          await reference.del("b");
          await reference.del("c");
        }
      });
    }
  });
}
