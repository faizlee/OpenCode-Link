import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeIdentity, publicHealth, publicRuntime, writeRuntimeRecord } from "./runtime.js";

const temporaryRoots: string[] = [];
const liveDataRoot = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "OpenCodexLink")
  : "";

function tempDataRoot() {
  const root = mkdtempSync(join(tmpdir(), "codex-link-runtime-"));
  temporaryRoots.push(root);
  expect(root).not.toBe(liveDataRoot);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime identity", () => {
  it("writes a proven identity record without exposing the control token in public views", () => {
    const dataRoot = tempDataRoot();
    const identity = createRuntimeIdentity({
      dataRoot,
      installRoot: join(dataRoot, "install"),
      port: 18901,
    });

    expect(identity.port).not.toBe(8787);
    expect(identity.productId).toBe("OpenCodexLink");
    expect(identity.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(identity.buildId).toBeTruthy();
    expect(identity.instanceId).toBeTruthy();
    expect(identity.controlToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(identity.dataRoot).toBe(dataRoot);

    const recordPath = writeRuntimeRecord(identity);
    expect(recordPath).toBe(join(dataRoot, "runtime.json"));
    const stored = JSON.parse(readFileSync(recordPath, "utf8")) as typeof identity;
    expect(stored.controlToken).toBe(identity.controlToken);
    expect(stored.instanceId).toBe(identity.instanceId);

    const published = publicRuntime(identity);
    expect(published).not.toHaveProperty("controlToken");
    expect(published).toMatchObject({
      ok: true,
      productId: "OpenCodexLink",
      version: identity.version,
      buildId: identity.buildId,
      instanceId: identity.instanceId,
      installRoot: identity.installRoot,
      dataRoot,
      port: 18901,
      servicePid: identity.servicePid,
    });

    expect(publicHealth(identity, false)).toEqual({
      ok: true,
      appServer: "stopped",
      productId: "OpenCodexLink",
      version: identity.version,
      buildId: identity.buildId,
      instanceId: identity.instanceId,
    });
  });
});
