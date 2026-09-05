import type { Store } from "./types.js";

/** In-process store. Correct for one instance, wrong the moment you scale out. */
export class MemoryStore implements Store {
  private readonly data = new Map<string, { value: string; expiresAt: number | null }>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  private live(key: string): { value: string; expiresAt: number | null } | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.clock()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.data.set(key, { value, expiresAt: ttlSeconds ? this.clock() + ttlSeconds * 1000 : null });
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const current = this.live(key);
    const next = (current ? Number(current.value) : 0) + 1;
    const expiresAt = current ? current.expiresAt : ttlSeconds ? this.clock() + ttlSeconds * 1000 : null;
    this.data.set(key, { value: String(next), expiresAt });
    return next;
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  /** Test helper. */
  size(): number {
    return this.data.size;
  }
}

/**
 * The subset of a Redis client the gate needs. Both ioredis and node-redis
 * satisfy it (node-redis names are upper-case; pass a small adapter).
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Redis-backed store. `incr` is atomic on the server, which is what makes the
 * daily budget safe across many instances; the TTL is attached on the first
 * increment so a day's counter disappears on its own.
 */
export class RedisStore implements Store {
  constructor(private readonly client: RedisLike) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await this.client.set(key, value, "EX", ttlSeconds);
    else await this.client.set(key, value);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const next = await this.client.incr(key);
    if (next === 1 && ttlSeconds) await this.client.expire(key, ttlSeconds);
    return next;
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}
