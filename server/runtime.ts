import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uploadRoot } from "./attachment-upload.js";

export const PRODUCT_ID = "OpenCodexLink";

export interface RuntimeIdentity {
  schema: 1;
  productId: typeof PRODUCT_ID;
  servicePid: number;
  version: string;
  buildId: string;
  instanceId: string;
  installRoot: string;
  dataRoot: string;
  port: number;
  startedAt: string;
  controlToken: string;
}

export interface ConsoleSettings {
  schema: 1;
  autoStart: boolean;
  openConsoleOnStart: boolean;
  keepRunningWhenBrowserCloses: true;
}

export function resolveDataRoot(override = process.env.CODEX_PWA_DATA_DIR) {
  if (override) return override;
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "OpenCodexLink");
  return join(process.cwd(), "work", "data");
}

function readPackageVersion(installRoot: string) {
  for (const root of [installRoot, process.cwd()]) {
    const packagePath = join(root, "package.json");
    if (!existsSync(packagePath)) continue;
    try {
      const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
      if (typeof version === "string" && version) return version;
    } catch {
      // Try the next known root rather than invent a product version.
    }
  }
  return "0.0.0";
}

function readBuildId(installRoot: string, version: string) {
  if (process.env.CODEX_PWA_BUILD_ID) return process.env.CODEX_PWA_BUILD_ID;
  const buildPath = join(installRoot, "build-info.json");
  if (existsSync(buildPath)) {
    try {
      const buildId = JSON.parse(readFileSync(buildPath, "utf8")).buildId;
      if (typeof buildId === "string" && buildId) return buildId;
    } catch {
      // Fall through to the development identifier.
    }
  }
  return `${version}-dev`;
}

export function createRuntimeIdentity(options: {
  dataRoot: string;
  installRoot?: string;
  port: number;
  now?: Date;
} ): RuntimeIdentity {
  const installRoot = options.installRoot ?? process.cwd();
  const version = readPackageVersion(installRoot);
  return {
    schema: 1,
    productId: PRODUCT_ID,
    servicePid: process.pid,
    version,
    buildId: readBuildId(installRoot, version),
    instanceId: randomUUID(),
    installRoot,
    dataRoot: options.dataRoot,
    port: options.port,
    startedAt: (options.now ?? new Date()).toISOString(),
    controlToken: randomBytes(32).toString("base64url"),
  };
}

export function runtimeRecordPath(dataRoot: string) {
  return join(dataRoot, "runtime.json");
}

export function writeRuntimeRecord(identity: RuntimeIdentity) {
  const path = runtimeRecordPath(identity.dataRoot);
  mkdirSync(identity.dataRoot, { recursive: true });
  writeFileSync(path, JSON.stringify(identity, null, 2), "utf8");
  return path;
}

export function clearRuntimeRecord(identity: RuntimeIdentity) {
  const path = runtimeRecordPath(identity.dataRoot);
  if (!existsSync(path)) return;
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as { instanceId?: string };
    if (stored.instanceId === identity.instanceId) rmSync(path);
  } catch {
    // Leave an unreadable record in place rather than guess.
  }
}

export function publicRuntime(identity: RuntimeIdentity) {
  return {
    ok: true as const,
    productId: identity.productId,
    version: identity.version,
    buildId: identity.buildId,
    instanceId: identity.instanceId,
    installRoot: identity.installRoot,
    dataRoot: identity.dataRoot,
    port: identity.port,
    startedAt: identity.startedAt,
    servicePid: identity.servicePid,
    tray: readTrayPublic(identity.dataRoot),
  };
}

export function publicHealth(identity: Pick<RuntimeIdentity, "productId" | "version" | "buildId" | "instanceId">, appServerReady: boolean) {
  return {
    ok: true as const,
    appServer: appServerReady ? "ready" as const : "stopped" as const,
    productId: identity.productId,
    version: identity.version,
    buildId: identity.buildId,
    instanceId: identity.instanceId,
  };
}

export function readConsoleSettings(dataRoot: string): ConsoleSettings {
  const defaults: ConsoleSettings = {
    schema: 1,
    autoStart: false,
    openConsoleOnStart: true,
    keepRunningWhenBrowserCloses: true,
  };
  const settingsPath = join(dataRoot, "settings.json");
  if (!existsSync(settingsPath)) return defaults;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<ConsoleSettings>;
    return {
      schema: 1,
      autoStart: Boolean(parsed.autoStart),
      openConsoleOnStart: parsed.openConsoleOnStart !== false,
      keepRunningWhenBrowserCloses: true,
    };
  } catch {
    return defaults;
  }
}

export function publicSettings(identity: RuntimeIdentity) {
  return {
    ...readConsoleSettings(identity.dataRoot),
    dataRoot: identity.dataRoot,
    uploadDir: uploadRoot(),
    logDir: join(identity.dataRoot, "logs"),
  };
}

function readTrayPublic(dataRoot: string) {
  const trayPath = join(dataRoot, "tray.json");
  if (!existsSync(trayPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(trayPath, "utf8")) as {
      productId?: string;
      version?: string;
      buildId?: string;
      installRoot?: string;
      trayPid?: number;
    };
    if (parsed.productId !== PRODUCT_ID) return null;
    return {
      version: parsed.version ?? "",
      buildId: parsed.buildId ?? "",
      installRoot: parsed.installRoot ?? "",
      trayPid: parsed.trayPid ?? 0,
    };
  } catch {
    return null;
  }
}
