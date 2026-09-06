# Store contract

`storeContract` is the executable contract for third-party `Store` implementations. It is exported from the `proactive-gate/store-contract` subpath and uses only `node:test` and `node:assert`.

```ts
import { storeContract } from "proactive-gate/store-contract";
import { PostgresStore } from "./store.js";
storeContract("PostgresStore", (clock) => new PostgresStore({ clock }), { expiry: "injected" });
```

The suite checks basic `get`, `set` and `del`, `incr` from an absent key, concurrent increment atomicity, expiry boundaries, matching TTL behaviour for `set` and `incr`, and a seeded random operation sequence against `MemoryStore`.

The factory receives a clock when `expiry` is `"injected"`. For stores whose backend owns the clock and cannot accept an injected clock, pass `expiry: "skip"`. The expiry tests are then reported as skipped and the non-expiry contract still runs. A factory can return `{ store, teardown }` when the store owns a connection that needs closing.
