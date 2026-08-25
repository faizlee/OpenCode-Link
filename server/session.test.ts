import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./session.js";

function responseRecorder() {
  const headers = new Map<string, string>();
  const response = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return response;
    },
  } as unknown as ServerResponse;
  return { response, headers };
}

function requestWithCookie(cookie = "") {
  return { headers: { cookie } } as IncomingMessage;
}

describe("SessionStore", () => {
  it("accepts a signed session after the server store is recreated", () => {
    const firstStore = new SessionStore("test-password");
    const { response, headers } = responseRecorder();
    firstStore.create(response, false);

    const cookie = headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const restartedStore = new SessionStore("test-password");

    expect(restartedStore.isAuthenticated(requestWithCookie(cookie))).toBe(true);
  });

  it("rejects forged and differently signed sessions", () => {
    const store = new SessionStore("test-password");
    const { response, headers } = responseRecorder();
    store.create(response, false);
    const cookie = headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    expect(store.isAuthenticated(requestWithCookie(`${cookie}x`))).toBe(false);
    expect(new SessionStore("another-password").isAuthenticated(requestWithCookie(cookie))).toBe(false);
  });

  it("clears the browser cookie on logout", () => {
    const store = new SessionStore("test-password");
    const { response, headers } = responseRecorder();
    store.clear(requestWithCookie(), response, true);

    expect(headers.get("set-cookie")).toContain("Max-Age=0");
    expect(headers.get("set-cookie")).toContain("Secure");
  });
});
