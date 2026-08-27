import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "./session.js";

const temporaryRoots: string[] = [];

function devicePath() {
  const root = mkdtempSync(join(tmpdir(), "codex-link-session-"));
  temporaryRoots.push(root);
  return join(root, "trusted-devices.json");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

function requestWithCookie(cookie = "", userAgent = "Android Test") {
  return {
    headers: { cookie, "user-agent": userAgent },
    socket: { remoteAddress: "192.168.1.20" },
  } as unknown as IncomingMessage;
}

describe("SessionStore", () => {
  it("keeps a trusted device signed in after the server store is recreated", () => {
    const path = devicePath();
    const firstStore = new SessionStore("test-password", path);
    const { response, headers } = responseRecorder();
    firstStore.create(requestWithCookie(), response, false);

    const cookie = headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const restartedStore = new SessionStore("test-password", path);

    expect(restartedStore.isAuthenticated(requestWithCookie(cookie))).toBe(true);
    expect(restartedStore.listDevices()).toMatchObject([{ name: "Android 手机" }]);
    expect(headers.get("set-cookie")).toContain("Max-Age=34560000");
  });

  it("rejects forged tokens and tokens missing from the trusted-device registry", () => {
    const path = devicePath();
    const store = new SessionStore("test-password", path);
    const { response, headers } = responseRecorder();
    store.create(requestWithCookie(), response, false);
    const cookie = headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    expect(store.isAuthenticated(requestWithCookie(`${cookie}x`))).toBe(false);
    expect(new SessionStore("test-password", devicePath()).isAuthenticated(requestWithCookie(cookie))).toBe(false);
  });

  it("revokes one trusted device without affecting another", () => {
    const store = new SessionStore("test-password", devicePath());
    const first = responseRecorder();
    const second = responseRecorder();
    store.create(requestWithCookie("", "iPhone"), first.response, false);
    store.create(requestWithCookie("", "Android"), second.response, false);
    const [latest, earlier] = store.listDevices();

    expect(store.revoke(earlier.id)).toBe(true);
    expect(store.listDevices()).toHaveLength(1);
    expect(store.listDevices()[0].id).toBe(latest.id);
  });

  it("logout revokes the current device and clears its browser cookie", () => {
    const store = new SessionStore("test-password", devicePath());
    const created = responseRecorder();
    store.create(requestWithCookie(), created.response, false);
    const cookie = created.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const cleared = responseRecorder();

    store.clear(requestWithCookie(cookie), cleared.response, true);

    expect(store.listDevices()).toHaveLength(0);
    expect(store.isAuthenticated(requestWithCookie(cookie))).toBe(false);
    expect(cleared.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(cleared.headers.get("set-cookie")).toContain("Secure");
  });
});
