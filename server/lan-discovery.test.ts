import { describe, expect, it } from "vitest";
import { normalizeLanName, stableOrigin } from "./lan-discovery.js";

describe("LAN stable name", () => {
  it("normalizes a configured .local name", () => {
    expect(normalizeLanName(" OpenCodexLink.local ")).toBe("opencodexlink");
    expect(normalizeLanName("My Codex 电脑")).toBe("my-codex");
  });

  it("omits the port only when the default-port redirect is ready", () => {
    expect(stableOrigin("opencodexlink.local", 8787, true)).toBe("http://opencodexlink.local");
    expect(stableOrigin("opencodexlink.local", 8787, false)).toBe("http://opencodexlink.local:8787");
  });
});
