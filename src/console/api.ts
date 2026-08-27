export async function readJson(response: Response) {
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(data.error ?? "请求失败");
  return data;
}

export async function loadOverview(fetchImpl: typeof fetch = fetch) {
  const [health, runtime, connection, devices] = await Promise.all([
    fetchImpl("/api/health", { cache: "no-store" }),
    fetchImpl("/api/runtime", { cache: "no-store" }),
    fetchImpl("/api/connection", { cache: "no-store" }),
    fetchImpl("/api/devices", { cache: "no-store" }),
  ]);
  const [healthBody, runtimeBody, connectionBody, devicesBody] = await Promise.all([
    readJson(health),
    readJson(runtime),
    readJson(connection),
    readJson(devices),
  ]);
  return {
    health: healthBody,
    runtime: runtimeBody,
    connection: connectionBody,
    devices: Array.isArray((devicesBody as { devices?: unknown }).devices)
      ? (devicesBody as { devices: unknown[] }).devices
      : [],
  };
}
