import { describe, expect, test } from "bun:test";
import {
  assertPublicBrowserAddress,
  authorizeBrowserUrl,
  type BrowserHostResolver,
} from "../../src/compute/browser-policy";

const publicResolver: BrowserHostResolver = async () => ["93.184.216.34", "2606:4700:4700::1111"];

describe("browser URL policy", () => {
  test("allows normalized public HTTP and HTTPS destinations", async () => {
    await expect(authorizeBrowserUrl("https://example.com/a", publicResolver))
      .resolves.toBe("https://example.com/a");
    await expect(authorizeBrowserUrl("http://8.8.8.8/", publicResolver))
      .resolves.toBe("http://8.8.8.8/");
    await expect(authorizeBrowserUrl("https://[2606:4700:4700::1111]/", publicResolver))
      .resolves.toBe("https://[2606:4700:4700::1111]/");
  });

  test("rejects every non-HTTP(S) scheme", async () => {
    for (const url of [
      "file:///etc/passwd",
      "data:text/plain,secret",
      "javascript:alert(1)",
      "ftp://example.com/file",
      "ws://example.com/socket",
    ]) {
      await expect(authorizeBrowserUrl(url, publicResolver)).rejects.toThrow("only HTTP(S) is allowed");
    }
  });

  test("rejects loopback, private, link-local, shared, unspecified, and metadata IPv4", async () => {
    for (const host of [
      "0.0.0.0",
      "10.0.0.1",
      "100.100.100.200",
      "127.0.0.1",
      "127.1.2.3",
      "168.63.129.16",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
    ]) {
      await expect(authorizeBrowserUrl(`http://${host}/`, publicResolver))
        .rejects.toThrow("blocked local/private address");
    }
  });

  test("rejects alternate textual encodings of loopback IPv4", async () => {
    for (const url of ["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/"]) {
      await expect(authorizeBrowserUrl(url, publicResolver)).rejects.toThrow("127.0.0.1");
    }
  });

  test("rejects loopback, unique-local, link-local, mapped, NAT64, and metadata IPv6", async () => {
    for (const host of [
      "::1",
      "fc00::1",
      "fd00:ec2::254",
      "fe80::1",
      "fec0::1",
      "::ffff:127.0.0.1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
    ]) {
      await expect(authorizeBrowserUrl(`http://[${host}]/`, publicResolver))
        .rejects.toThrow("blocked local/private address");
    }
  });

  test("rejects metadata and local-service hostnames without trusting DNS", async () => {
    let resolved = false;
    const resolver: BrowserHostResolver = async () => { resolved = true; return ["93.184.216.34"]; };
    for (const host of [
      "localhost",
      "api.localhost",
      "printer.local",
      "metadata",
      "metadata.goog",
      "metadata.internal",
      "metadata.google.internal",
      "instance-data.ec2.internal",
    ]) {
      await expect(authorizeBrowserUrl(`http://${host}/`, resolver)).rejects.toThrow("hostname");
    }
    expect(resolved).toBe(false);
  });

  test("rejects public-looking redirect or subrequest hosts when DNS resolves private", async () => {
    const resolver: BrowserHostResolver = async (hostname) => hostname === "rebind.example"
      ? ["192.168.50.10"]
      : ["93.184.216.34"];
    await expect(authorizeBrowserUrl("https://rebind.example/internal", resolver))
      .rejects.toThrow("192.168.50.10");
    await expect(authorizeBrowserUrl("https://public.example/", resolver))
      .resolves.toBe("https://public.example/");
  });

  test("response-address verification rejects private addresses independently of URLs", () => {
    expect(() => assertPublicBrowserAddress("127.0.0.1", "redirect response")).toThrow("redirect response");
    expect(() => assertPublicBrowserAddress("fe80::1", "subresource response")).toThrow("subresource response");
    expect(() => assertPublicBrowserAddress("8.8.8.8")).not.toThrow();
  });
});
