export const UNUSED_DEVICE_MS = 30 * 24 * 60 * 60 * 1000;

export function isUnusedDevice(lastSeenAt: number, now = Date.now()) {
  return now - lastSeenAt >= UNUSED_DEVICE_MS;
}

export function formatDeviceWhen(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
