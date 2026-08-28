import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function requestWithCookie(cookie = "", userAgent = "Android Test", clientHintModel = "") {
  return {
    headers: {
      cookie,
      "user-agent": userAgent,
      ...(clientHintModel ? { "sec-ch-ua-model": `"${clientHintModel}"` } : {}),
    },
    socket: { remoteAddress: "192.168.1.20" },
  } as unknown as IncomingMessage;
}

describe("SessionStore", () => {
  it("requires a trusted-device token for every unpaired request", () => {
    const store = new SessionStore(devicePath());

    expect(store.authRequired).toBe(true);
    expect(store.isAuthenticated(requestWithCookie())).toBe(false);
  });

  it("keeps a trusted device signed in after the server store is recreated", () => {
    const path = devicePath();
    const firstStore = new SessionStore(path);
    const { response, headers } = responseRecorder();
    firstStore.create(requestWithCookie(), response, false);

    const cookie = headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const restartedStore = new SessionStore(path);

    expect(restartedStore.isAuthenticated(requestWithCookie(cookie))).toBe(true);
    expect(restartedStore.listDevices()).toMatchObject([{ name: "Android 手机" }]);
    expect(headers.get("set-cookie")).toContain("Max-Age=34560000");
    expect(headers.get("set-cookie")).toContain("SameSite=Lax");
  });

  it("rejects forged tokens and tokens missing from the trusted-device registry", () => {
    const path = devicePath();
    const store = new SessionStore(path);
    const { response, headers } = responseRecorder();
    store.create(requestWithCookie(), response, false);
    const cookie = headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    expect(store.isAuthenticated(requestWithCookie(`${cookie}x`))).toBe(false);
    expect(new SessionStore(devicePath()).isAuthenticated(requestWithCookie(cookie))).toBe(false);
  });

  it("adopts the same trusted-device identity on another origin without adding a row", () => {
    const store = new SessionStore(devicePath());
    const created = responseRecorder();
    store.create(requestWithCookie(), created.response, false);
    const cookie = created.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const raw = store.sessionToken(requestWithCookie(cookie));
    const adopted = responseRecorder();

    expect(raw).toBeTruthy();
    expect(store.adopt(raw ?? "", adopted.response, false)).toBe(true);
    expect(store.listDevices()).toHaveLength(1);
    expect(adopted.headers.get("set-cookie")?.split(";", 1)[0]).toBe(cookie);
    expect(store.isAuthenticated(requestWithCookie(cookie))).toBe(true);
  });

  it("refreshes a repeated scan without adding a trusted-device row", () => {
    const store = new SessionStore(devicePath());
    const created = responseRecorder();
    store.create(requestWithCookie(), created.response, false);
    const cookie = created.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    expect(store.refresh(requestWithCookie(cookie), responseRecorder().response, false)).toBe(true);
    expect(store.listDevices()).toHaveLength(1);
    expect(store.adopt("v2.invalid.secret", responseRecorder().response, false)).toBe(false);
  });

  it("uses the phone model as the default device name when the browser exposes it", () => {
    const androidUa = "Mozilla/5.0 (Linux; Android 14; SM-S9280 Build/UP1A.231005.007) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";
    const store = new SessionStore(devicePath());

    store.create(requestWithCookie("", androidUa), responseRecorder().response, false);
    store.create(requestWithCookie("", "Mozilla/5.0 (Linux; Android 10; K)", "23127PN0CC"), responseRecorder().response, false);
    store.create(requestWithCookie("", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), responseRecorder().response, false);

    expect(store.listDevices().map((device) => device.name).sort()).toEqual(["23127PN0CC", "SM-S9280", "iPhone"].sort());
  });

  it("upgrades a generic Android name on the next visit but preserves a user rename", () => {
    const store = new SessionStore(devicePath());
    const created = responseRecorder();
    store.create(requestWithCookie(), created.response, false);
    const cookie = created.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const androidUa = "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro Build/AP4A.250105.002) AppleWebKit/537.36 Chrome/132 Mobile Safari/537.36";

    expect(store.refresh(requestWithCookie(cookie, androidUa), responseRecorder().response, false)).toBe(true);
    expect(store.listDevices()[0].name).toBe("Pixel 9 Pro");

    const id = store.listDevices()[0].id;
    expect(store.rename(id, "我的工作手机")).toBe(true);
    expect(store.refresh(requestWithCookie(cookie, androidUa, "Pixel 10 Pro"), responseRecorder().response, false)).toBe(true);
    expect(store.listDevices()[0].name).toBe("我的工作手机");
  });

  it("revokes one trusted device without affecting another", () => {
    const store = new SessionStore(devicePath());
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
    const store = new SessionStore(devicePath());
    const created = responseRecorder();
    store.create(requestWithCookie(), created.response, false);
    const cookie = created.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const cleared = responseRecorder();

    store.clear(requestWithCookie(cookie), cleared.response, true);

    expect(store.listDevices()).toHaveLength(0);
    expect(store.isAuthenticated(requestWithCookie(cookie))).toBe(false);
    expect(cleared.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(cleared.headers.get("set-cookie")).toContain("Secure");
    expect(cleared.headers.get("set-cookie")).toContain("SameSite=Lax");
  });

  it("renames a device without changing id, token, or adding a row", () => {
    const path = devicePath();
    const store = new SessionStore(path);
    const created = responseRecorder();
    store.create(requestWithCookie(), created.response, false);
    const cookie = created.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const before = JSON.parse(readFileSync(path, "utf8")) as { devices: Array<{ id: string; tokenHash: string; name: string }> };
    const [device] = store.listDevices();

    expect(store.rename(device.id, "书房 iPhone")).toBe(true);
    expect(store.listDevices()).toMatchObject([{ id: device.id, name: "书房 iPhone" }]);
    expect(store.isAuthenticated(requestWithCookie(cookie))).toBe(true);
    const after = JSON.parse(readFileSync(path, "utf8")) as { devices: Array<{ id: string; tokenHash: string; name: string }> };
    expect(after.devices).toHaveLength(1);
    expect(after.devices[0].id).toBe(before.devices[0].id);
    expect(after.devices[0].tokenHash).toBe(before.devices[0].tokenHash);
    expect(after.devices[0].name).toBe("书房 iPhone");
  });

  it("batch-revokes only the selected device ids", () => {
    const store = new SessionStore(devicePath());
    store.create(requestWithCookie("", "iPhone"), responseRecorder().response, false);
    store.create(requestWithCookie("", "Android"), responseRecorder().response, false);
    store.create(requestWithCookie("", "Windows"), responseRecorder().response, false);
    const [latest, middle, earliest] = store.listDevices();

    expect(store.revokeMany([earliest.id, latest.id, "missing"])).toEqual({ revoked: [earliest.id, latest.id] });
    expect(store.listDevices()).toMatchObject([{ id: middle.id }]);
  });

  it("does not overwrite a corrupt device registry with an empty table", () => {
    const path = devicePath();
    writeFileSync(path, "{not-json", "utf8");
    const store = new SessionStore(path);

    expect(store.loadError).toBe(true);
    expect(store.listDevices()).toEqual([]);
    expect(store.rename("any", "新名称")).toBe(false);
    expect(store.revoke("any")).toBe(false);
    expect(store.revokeMany(["any"])).toEqual({ revoked: [] });
    expect(readFileSync(path, "utf8")).toBe("{not-json");
  });
});
