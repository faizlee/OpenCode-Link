import { describe, expect, it } from "vitest";
import { PairingStore } from "./pairing.js";

describe("PairingStore", () => {
  it("accepts only the latest unexpired ticket", () => {
    const store = new PairingStore();
    const first = store.issue(1_000, 5_000);
    expect(store.accepts(first.token, 5_999)).toBe(true);
    expect(store.accepts(first.token, 6_001)).toBe(false);

    const second = store.issue(7_000, 5_000);
    expect(store.accepts(first.token, 7_001)).toBe(false);
    expect(store.accepts(second.token, 7_001)).toBe(true);
  });
});
