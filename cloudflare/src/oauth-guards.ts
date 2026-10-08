const WINDOW_SECONDS = 900;
const MAX_FAILURES = 5;
type Store = Pick<KVNamespace, "get" | "put" | "delete">;

export async function failureKey(request: Request): Promise<string> {
  // The header is set at Cloudflare's trusted edge; do not accept a client-supplied X-Forwarded-For.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const digest = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return "weknora-oauth-fail:" + digest;
}

export async function authIsBlocked(store: Store, key: string): Promise<boolean> {
  const value = Number(await store.get(key) ?? "0");
  return value >= MAX_FAILURES;
}

export async function recordAuthFailure(store: Store, key: string): Promise<void> {
  const count = Number(await store.get(key) ?? "0");
  await store.put(key, String(Math.min(count + 1, MAX_FAILURES)), { expirationTtl: WINDOW_SECONDS });
}

export async function clearAuthFailures(store: Store, key: string): Promise<void> {
  await store.delete(key);
}
