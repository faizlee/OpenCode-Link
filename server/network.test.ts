import { describe, expect, it } from "vitest";
import { isPrivateIpv4, isTailscaleIpv4, listLanAddresses, listTailscaleAddresses } from "./network.js";

function ipv4(address: string): import("node:os").NetworkInterfaceInfo {
  return { address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/24` };
}

describe("LAN address discovery", () => {
  it("accepts RFC1918 addresses only", () => {
    expect(isPrivateIpv4("192.168.1.2")).toBe(true);
    expect(isPrivateIpv4("172.16.1.2")).toBe(true);
    expect(isPrivateIpv4("172.31.1.2")).toBe(true);
    expect(isPrivateIpv4("100.83.1.2")).toBe(false);
    expect(isPrivateIpv4("198.18.0.1")).toBe(false);
  });

  it("recognizes Tailscale CGNAT addresses without treating them as physical LAN", () => {
    expect(isTailscaleIpv4("100.64.0.1")).toBe(true);
    expect(isTailscaleIpv4("100.127.255.254")).toBe(true);
    expect(isTailscaleIpv4("100.128.0.1")).toBe(false);
    expect(isTailscaleIpv4("192.168.1.2")).toBe(false);

    expect(listTailscaleAddresses(8787, {
      "Tailscale": [ipv4("100.83.218.96")],
      "Wi-Fi": [ipv4("192.168.31.181")],
      "Other tunnel": [ipv4("100.90.1.2")],
    })).toEqual([
      { name: "Tailscale", address: "100.83.218.96", origin: "http://100.83.218.96:8787", tailscale: true },
    ]);
  });

  it("prefers physical LAN adapters and excludes virtual tunnels", () => {
    const result = listLanAddresses(8787, {
      "OrayBoxVpnEnt Tunnel": [ipv4("172.16.0.67")],
      "Tailscale": [ipv4("100.83.218.96")],
      "vEthernet (WSL)": [ipv4("172.17.64.1")],
      "Wi-Fi": [ipv4("192.168.31.181")],
      "以太网": [ipv4("10.0.0.8")],
    });

    expect(result).toEqual([
      { name: "Wi-Fi", address: "192.168.31.181", origin: "http://192.168.31.181:8787" },
      { name: "以太网", address: "10.0.0.8", origin: "http://10.0.0.8:8787" },
    ]);
  });
});
