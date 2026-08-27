import { describe, expect, it } from "vitest";
import { loadOverview } from "./api";

describe("desktop console loaders", () => {
  it("loads overview status without issuing a pairing ticket", async () => {
    const requested: Array<{ url: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requested.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      return new Response(JSON.stringify({ ok: true, devices: [], recommendedOrigin: "http://127.0.0.1:18911" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await loadOverview(fetchImpl);

    expect(requested.some((entry) => entry.url.includes("/api/pairing"))).toBe(false);
    expect(requested.map((entry) => entry.url).sort()).toEqual([
      "/api/connection",
      "/api/devices",
      "/api/health",
      "/api/runtime",
    ]);
  });
});
