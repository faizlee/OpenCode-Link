import { describe, expect, it } from "vitest";
import {
  credentialFromHash,
  isRouteProbeMessage,
  isStableHost,
  isTailscaleHost,
  isTrustedRouteOrigin,
  routeHash,
  sanitizeRouteLinks,
} from "./route-failover";

describe("route failover helpers", () => {
  it("recognizes supported LAN, stable-name, and Tailscale origins", () => {
    expect(isTrustedRouteOrigin("http://192.168.31.8:8787")).toBe(true);
    expect(isTrustedRouteOrigin("http://10.0.0.8:8787")).toBe(true);
    expect(isTrustedRouteOrigin("http://opencodexlink.local")).toBe(true);
    expect(isTrustedRouteOrigin("http://100.83.218.96:8787")).toBe(true);
    expect(isTrustedRouteOrigin("https://faiz.tail84f8ca.ts.net")).toBe(true);
    expect(isStableHost("opencodexlink.local")).toBe(true);
    expect(isTailscaleHost("100.83.218.96")).toBe(true);
    expect(isTailscaleHost("faiz.tail84f8ca.ts.net")).toBe(true);
  });

  it("rejects credential exfiltration targets and deduplicates candidates", () => {
    expect(isTrustedRouteOrigin("https://example.com")).toBe(false);
    expect(isTrustedRouteOrigin("http://user:pass@192.168.31.8:8787")).toBe(false);
    expect(isTrustedRouteOrigin("http://192.168.31.8:8787/path")).toBe(false);
    expect(sanitizeRouteLinks([
      { origin: "http://100.83.218.96:8787", tailscale: true },
      { origin: "http://100.83.218.96:8787", tailscale: true },
      { origin: "https://example.com" },
    ])).toEqual([{ origin: "http://100.83.218.96:8787", tailscale: true }]);
  });

  it("moves a route credential through a URL fragment instead of a request path", () => {
    const credential = "r1.device.secret";
    const hash = routeHash(credential);
    expect(hash).toBe("#ocl-route=r1.device.secret");
    expect(credentialFromHash(hash)).toBe(credential);
    expect(credentialFromHash("#other=value")).toBe("");
  });

  it("accepts only the expected OpenCodex Link iframe probe origin", () => {
    const message = { type: "opencodexlink-route-probe", productId: "OpenCodexLink" };
    expect(isRouteProbeMessage("http://100.83.218.96:8787", "http://100.83.218.96:8787", message)).toBe(true);
    expect(isRouteProbeMessage("http://attacker.test", "http://100.83.218.96:8787", message)).toBe(false);
    expect(isRouteProbeMessage("http://100.83.218.96:8787", "http://100.83.218.96:8787", { ...message, productId: "Other" })).toBe(false);
  });
});
