/**
 * Whether the live integration test may run against `url`. It writes (grants,
 * revokes, deletes), so only an allowlist is accepted: the development API and
 * local hosts. Anything else, including production in any spelling
 * (`https://API.perms.io`, `https://api.perms.io:443`, a trailing dot, ...), is
 * refused.
 */
export function isAllowedLiveTarget(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password) return false;
  // URL lowercases the host; a trailing dot names the same host.
  const host = parsed.hostname.replace(/\.$/, "");
  return (
    host === "dev-api.perms.io" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".localhost") ||
    host.endsWith(".test")
  );
}
