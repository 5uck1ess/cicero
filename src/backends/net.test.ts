import { test, expect } from "bun:test";
import { isKeylessHost, isLocalHost, isPrivateLanHost, httpBase } from "./net";

test("isLocalHost is true for unset and loopback hosts", () => {
  expect(isLocalHost(undefined)).toBe(true);
  expect(isLocalHost("")).toBe(true);
  expect(isLocalHost("localhost")).toBe(true);
  expect(isLocalHost("127.0.0.1")).toBe(true);
  expect(isLocalHost("::1")).toBe(true);
  expect(isLocalHost("[::1]")).toBe(true);
});

test("isLocalHost is false for a remote host", () => {
  expect(isLocalHost("192.168.1.10")).toBe(false);
  expect(isLocalHost("gpu-box.local")).toBe(false);
});

test("httpBase defaults host to localhost and builds the URL", () => {
  expect(httpBase(undefined, 8083)).toBe("http://localhost:8083");
  expect(httpBase("192.168.1.10", 10300)).toBe("http://192.168.1.10:10300");
  expect(httpBase("fd12:3456::5", 8080)).toBe("http://[fd12:3456::5]:8080");
  expect(httpBase("[fd12:3456::5]", 8080)).toBe("http://[fd12:3456::5]:8080");
  expect(httpBase("fe80::1%en0", 8080)).toBe("http://[fe80::1%25en0]:8080");
});

test("private LAN trust requires a real private literal or valid mDNS hostname", () => {
  for (const host of [
    "10.0.0.2",
    "192.168.1.50",
    "172.16.0.1",
    "172.31.255.254",
    "gpu-box.local",
    "fc00::1",
    "fd12:3456::1",
    "[fd12:3456::1]",
    "fe80::1%en0",
    "::ffff:10.0.0.1",
    "::ffff:c0a8:105",
  ]) {
    expect(isPrivateLanHost(host)).toBe(true);
    expect(isKeylessHost(host)).toBe(true);
  }
  for (const host of [
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "10.attacker.example",
    "192.168.attacker.example",
    "172.16.attacker.example",
    "2001:4860:4860::8888",
    "2002:0a00:0001::1",
    "64:ff9b::a00:1",
    "::ffff:8.8.8.8",
    "fec0::1",
    ".local",
    "gpu.local.evil",
  ]) {
    expect(isPrivateLanHost(host)).toBe(false);
    expect(isKeylessHost(host)).toBe(false);
  }
});
