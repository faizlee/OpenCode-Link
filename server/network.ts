import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export interface LanAddress {
  name: string;
  address: string;
  origin: string;
}

type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

const VIRTUAL_INTERFACE = /tailscale|oray|pgy|wintun|tunnel|vethernet|hyper-v|wsl|default switch|loopback|meta/i;
const PHYSICAL_INTERFACE = /wi-?fi|wlan|wireless|无线|ethernet|以太网/i;

export function isPrivateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function score(name: string, address: string) {
  let result = PHYSICAL_INTERFACE.test(name) ? 100 : 0;
  if (address.startsWith("192.168.")) result += 30;
  else if (address.startsWith("10.")) result += 20;
  else result += 10;
  return result;
}

export function listLanAddresses(port: number, interfaces: InterfaceMap = networkInterfaces()) {
  const candidates: Array<LanAddress & { score: number }> = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries || VIRTUAL_INTERFACE.test(name)) continue;
    for (const entry of entries) {
      if (entry.internal || entry.family !== "IPv4" || !isPrivateIpv4(entry.address)) continue;
      candidates.push({
        name,
        address: entry.address,
        origin: `http://${entry.address}:${port}`,
        score: score(name, entry.address),
      });
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .filter((candidate, index, all) => all.findIndex((item) => item.address === candidate.address) === index)
    .map(({ score: _score, ...candidate }) => candidate);
}
