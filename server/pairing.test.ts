import { describe, expect, it } from "vitest";
import { PairingStore } from "./pairing.js";

describe("PairingStore", () => {
  it("consumes only the latest unexpired ticket once", () => {
    const store = new PairingStore();
    const first = store.issue({ now: 1_000, ttlMs: 5_000 });
    expect(store.consume(first.token, 6_001)).toBeNull();

    const second = store.issue({ now: 7_000, ttlMs: 5_000 });
    expect(store.consume(first.token, 7_001)).toBeNull();
    expect(store.consume(second.token, 7_001)).toEqual(second);
    expect(store.consume(second.token, 7_002)).toBeNull();
  });

  it("keeps an existing trusted-device token server-side for origin migration", () => {
    const store = new PairingStore();
    const ticket = store.issue({ now: 1_000, sessionToken: "v2.device.secret" });

    expect(store.consume(ticket.token, 1_001)).toMatchObject({ sessionToken: "v2.device.secret" });
  });
});
