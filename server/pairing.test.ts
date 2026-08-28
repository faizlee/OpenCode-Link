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

  it("keeps concurrent one-time migrations while a refreshed QR only replaces older pairing tickets", () => {
    const store = new PairingStore();
    const oldPairing = store.issue({ now: 1_000 });
    const tailscale = store.issue({ now: 1_001, sessionToken: "v2.device.secret", kind: "migration" });
    const stable = store.issue({ now: 1_002, sessionToken: "v2.device.secret", kind: "migration" });

    expect(store.consume(oldPairing.token, 1_003)).toEqual(oldPairing);
    expect(store.consume(tailscale.token, 1_003)).toEqual(tailscale);
    expect(store.consume(stable.token, 1_003)).toEqual(stable);
    expect(store.consume(tailscale.token, 1_004)).toBeNull();

    const refreshedPairing = store.issue({ now: 2_000 });
    const pendingMigration = store.issue({ now: 2_001, sessionToken: "v2.device.secret", kind: "migration" });
    store.issue({ now: 2_002 });
    expect(store.consume(refreshedPairing.token, 2_003)).toBeNull();
    expect(store.consume(pendingMigration.token, 2_003)).toEqual(pendingMigration);
  });
});
