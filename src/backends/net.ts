import { BlockList, isIP } from "node:net";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", ""]);

function unbracketHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
}

function addressWithoutZone(host: string): string {
  return unbracketHost(host).split("%", 1)[0] ?? "";
}

/** True when host is unset or points at the local machine. */
export function isLocalHost(host: string | undefined): boolean {
  return host === undefined || LOCAL_HOSTS.has(addressWithoutZone(host));
}

const MDNS_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/i;

function isPrivateV4(host: string): boolean {
  if (isIP(host) !== 4) return false;
  const octets = host.split(".").map(Number);
  return octets[0] === 10
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31);
}

const PRIVATE_V6 = new BlockList();
PRIVATE_V6.addSubnet("fc00::", 7, "ipv6");
PRIVATE_V6.addSubnet("fe80::", 10, "ipv6");

function canonicalV6(host: string): string | null {
  const literal = addressWithoutZone(host);
  if (isIP(literal) !== 6) return null;
  try {
    // URL canonicalization expands dotted IPv4 tails and normalizes equivalent
    // spellings before the trust decision (e.g. ::ffff:10.0.0.1).
    return new URL(`http://[${literal}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

function mappedV4(host: string): string | null {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!match) return null;
  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function isPrivateV6(host: string): boolean {
  const canonical = canonicalV6(host);
  if (!canonical) return false;
  const mapped = mappedV4(canonical);
  if (mapped) return isPrivateV4(mapped) || mapped === "127.0.0.1" || mapped === "0.0.0.0";
  return PRIVATE_V6.check(canonical, "ipv6");
}

/** True for RFC-1918/mapped IPv4, IPv6 ULA/link-local, or valid mDNS. */
export function isPrivateLanHost(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = unbracketHost(host);
  return isPrivateV4(normalized) || isPrivateV6(normalized) || MDNS_HOST.test(normalized);
}

/**
 * Hosts that need no API key: the local machine OR a trusted private LAN.
 *
 * A keyless model server (LM Studio, vLLM, llama-swap, a LAN Hermes) is just as
 * keyless at `192.168.1.50` as at `localhost`. Distinct from {@link isLocalHost},
 * which governs whether to *launch* a local managed server and must stay strict.
 */
export function isKeylessHost(host: string | undefined): boolean {
  return isLocalHost(host) || isPrivateLanHost(host);
}

/** Build an http base URL (`http://host:port`), defaulting host to localhost. */
export function httpBase(host: string | undefined, port: number): string {
  const normalized = unbracketHost(host ?? "localhost");
  const literal = addressWithoutZone(normalized);
  if (isIP(literal) === 6) {
    const scoped = normalized.replace(/%(?!25)/, "%25");
    return `http://[${scoped}]:${port}`;
  }
  return `http://${normalized}:${port}`;
}
