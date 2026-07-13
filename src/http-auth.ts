import { timingSafeEqual } from "node:crypto";

/** Constant-time token comparison for HTTP and WebSocket authentication. */
export function tokenMatches(provided: string, expected: string): boolean {
  // An empty configured secret must never turn an absent Authorization header
  // into a successful authentication check.
  if (expected.length === 0 || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Read a bearer token first, then fall back to the browser-friendly query token. */
export function presentedToken(req: Request, url: URL): string {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return url.searchParams.get("token") ?? "";
}
