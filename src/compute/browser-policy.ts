import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type BrowserHostResolver = (hostname: string) => Promise<readonly string[]>;

export class BrowserUrlPolicyError extends Error {
  override readonly name = "BrowserUrlPolicyError";
}

function ipv4BlockList(): BlockList {
  const blocked = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],       // unspecified / this network
    ["10.0.0.0", 8],      // RFC 1918
    ["100.64.0.0", 10],   // shared address space, including Alibaba metadata
    ["127.0.0.0", 8],     // loopback
    ["168.63.129.16", 32], // Azure host-fabric virtual IP
    ["169.254.0.0", 16],  // link-local and common cloud metadata
    ["172.16.0.0", 12],   // RFC 1918
    ["192.0.0.0", 24],    // IETF protocol assignments
    ["192.0.2.0", 24],    // documentation-only
    ["192.168.0.0", 16],  // RFC 1918
    ["198.18.0.0", 15],   // benchmark networks
    ["198.51.100.0", 24], // documentation-only
    ["203.0.113.0", 24],  // documentation-only
    ["224.0.0.0", 4],     // multicast
    ["240.0.0.0", 4],     // reserved / broadcast
  ] as const) blocked.addSubnet(network, prefix, "ipv4");
  return blocked;
}

function ipv6BlockList(): BlockList {
  const blocked = new BlockList();
  for (const [network, prefix] of [
    ["::", 96],            // unspecified and IPv4-compatible forms
    ["::ffff:0:0", 96],    // IPv4-mapped forms; normal IPv4 URLs remain available
    ["64:ff9b::", 96],     // NAT64 embeds an IPv4 destination
    ["100::", 64],         // discard-only
    ["2001::", 32],        // Teredo
    ["2001:2::", 48],      // benchmark
    ["2001:db8::", 32],    // documentation-only
    ["2002::", 16],        // 6to4 embeds an IPv4 destination
    ["fc00::", 7],         // unique-local
    ["fe80::", 10],        // link-local
    ["fec0::", 10],        // deprecated site-local
    ["ff00::", 8],         // multicast
  ] as const) blocked.addSubnet(network, prefix, "ipv6");
  return blocked;
}

const BLOCKED_IPV4 = ipv4BlockList();
const BLOCKED_IPV6 = ipv6BlockList();
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.goog",
  "metadata.internal",
  "metadata.google.internal",
  "metadata.azure.internal",
  "metadata.aws.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

function bareHostname(hostname: string): string {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return unbracketed.replace(/\.$/, "").toLowerCase();
}

function bareAddress(address: string): string {
  const unbracketed = address.startsWith("[") && address.endsWith("]")
    ? address.slice(1, -1)
    : address;
  return unbracketed.split("%")[0] ?? unbracketed;
}

export function isBlockedBrowserAddress(address: string): boolean {
  const normalized = bareAddress(address);
  const family = isIP(normalized);
  if (family === 4) return BLOCKED_IPV4.check(normalized, "ipv4");
  if (family === 6) return BLOCKED_IPV6.check(normalized, "ipv6");
  return true; // an unverifiable server address is never an authorization bypass
}

export function assertPublicBrowserAddress(address: string, context = "browser destination"): void {
  if (isBlockedBrowserAddress(address)) {
    throw new BrowserUrlPolicyError(`${context} uses blocked local/private address ${address}`);
  }
}

const systemResolver: BrowserHostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

/**
 * Parse, resolve, and authorize one browser network destination. This is a hard
 * gate, separate from human confirmation: approval can authorize a public web
 * action, but can never authorize SSRF into the host or its trusted networks.
 */
export async function authorizeBrowserUrl(
  raw: string,
  resolveHost: BrowserHostResolver = systemResolver,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserUrlPolicyError(`browser URL is invalid: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserUrlPolicyError(`browser URL scheme '${url.protocol || "(missing)"}' is blocked; only HTTP(S) is allowed`);
  }

  const hostname = bareHostname(url.hostname);
  if (!hostname) throw new BrowserUrlPolicyError("browser URL has no hostname");
  if (
    BLOCKED_HOSTNAMES.has(hostname)
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
  ) {
    throw new BrowserUrlPolicyError(`browser destination hostname '${hostname}' is blocked`);
  }

  if (isIP(hostname) !== 0) {
    assertPublicBrowserAddress(hostname);
    return url.href;
  }

  let addresses: readonly string[];
  try {
    addresses = await resolveHost(hostname);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new BrowserUrlPolicyError(`browser destination '${hostname}' could not be resolved: ${detail}`);
  }
  if (addresses.length === 0) {
    throw new BrowserUrlPolicyError(`browser destination '${hostname}' resolved to no addresses`);
  }
  for (const address of addresses) {
    assertPublicBrowserAddress(address, `browser destination '${hostname}'`);
  }
  return url.href;
}
