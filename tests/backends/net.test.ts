import { test, expect } from "bun:test";
import { isLocalHost, isPrivateLanHost, isKeylessHost, httpBase } from "../../src/backends/net";

test("isLocalHost is true for the loopback set and unset host, false otherwise", () => {
  for (const h of [undefined, "", "localhost", "127.0.0.1", "::1", "0.0.0.0"]) {
    expect(isLocalHost(h)).toBe(true);
  }
  for (const h of ["192.168.1.50", "10.0.0.2", "gpu-box.local", "example.com"]) {
    expect(isLocalHost(h)).toBe(false);
  }
});

test("isPrivateLanHost matches private IPv4/IPv6 and *.local, not public IPs", () => {
  for (const h of [
    "10.0.0.2",
    "192.168.1.50",
    "172.16.0.1",
    "172.31.255.254",
    "gpu-box.local",
    "fc00::1",
    "fdff::1",
    "fe80::1%en0",
    "::ffff:10.0.0.2",
  ]) {
    expect(isPrivateLanHost(h)).toBe(true);
  }
  // 172.15 and 172.32 are outside the 172.16/12 block; 8.8.8.8 is public.
  for (const h of [
    undefined,
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "example.com",
    "localhost",
  ]) {
    expect(isPrivateLanHost(h)).toBe(false);
  }
});

test("isKeylessHost covers both loopback and the private LAN", () => {
  for (const h of ["localhost", "127.0.0.1", "192.168.1.50", "10.1.2.3", "hermes.local"]) {
    expect(isKeylessHost(h)).toBe(true);
  }
  for (const h of ["api.openai.com", "8.8.8.8"]) {
    expect(isKeylessHost(h)).toBe(false);
  }
});

test("httpBase builds host:port, defaulting host to localhost", () => {
  expect(httpBase("192.168.1.50", 8080)).toBe("http://192.168.1.50:8080");
  expect(httpBase(undefined, 9119)).toBe("http://localhost:9119");
  expect(httpBase("fd00::5", 8080)).toBe("http://[fd00::5]:8080");
});
