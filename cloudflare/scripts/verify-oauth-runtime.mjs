// Run after build:pages. All credentials and KV data below are local fixtures.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const origins = ["https://weknora-mcp-chuyuai.pages.dev", "https://weknora.xzdq.eu.org"];
const ownerSecret = randomBytes(24).toString("hex");
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
  name: "oauth-verification",
  scriptPath: "pages-bundle/index.js",
  modules: true,
  compatibilityDate: "2026-10-04",
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  kvNamespaces: ["OAUTH_KV"],
  bindings: {OWNER_AUTH_SECRET: ownerSecret, WEKNORA_BASE_URL: "https://weknora.invalid/api/v1"},
}] }));

try {
  for (const origin of origins) {
    const send = (path, init) => mf.dispatchFetch(`${origin}${path}`, init);
    const discovery = await (await send("/.well-known/oauth-authorization-server")).json();
    assert.equal(discovery.issuer, origin);
    const resource = await (await send("/.well-known/oauth-protected-resource/mcp")).json();
    assert.equal(resource.resource, `${origin}/mcp`);
    assert.deepEqual(resource.authorization_servers, [origin]);
    assert.equal((await send("/mcp")).status, 401);

    const registration = await send("/oauth/register", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({client_name: "Local protocol verification", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"]}),
    });
    assert.equal(registration.status, 201);
    const {client_id} = await registration.json();
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({response_type: "code", client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "local-verification", scope: "mcp:read offline_access", resource: `${origin}/mcp`});
    const path = `/authorize?${query}`;
    const page = await send(path);
    assert.equal(page.status, 200, page.status === 200 ? undefined : await page.text());
    const policy = page.headers.get("content-security-policy");
    assert.match(policy, /form-action[^;]*https:\/\/claude\.ai/);
    assert.match(policy, /form-action[^;]*https:\/\/chatgpt\.com/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(await page.text(), /src="\/icon.png"/);
    const approval = await send(path, {method: "POST", body: new URLSearchParams({owner_secret: ownerSecret}), redirect: "manual"});
    assert.equal(approval.status, 302);
    const callback = new URL(approval.headers.get("location"));
    assert.equal(callback.origin, "https://claude.ai");
    assert.equal(callback.searchParams.get("state"), "local-verification");
    assert.equal(callback.searchParams.get("iss"), origin);
    const tokenResponse = await send("/oauth/token", {method: "POST", body: new URLSearchParams({grant_type: "authorization_code", client_id, code: callback.searchParams.get("code"), redirect_uri: query.get("redirect_uri"), code_verifier: verifier, resource: `${origin}/mcp`})});
    assert.equal(tokenResponse.status, 200);
    const token = await tokenResponse.json();
    assert.ok(token.access_token);
    assert.ok(token.refresh_token);
    const headers = {Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream"};
    const initialized = await send("/mcp", {method: "POST", headers, body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "initialize", params: {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "local-test", version: "1"}}})});
    assert.equal(initialized.status, 200);
    assert.equal((await initialized.json()).result.serverInfo.icons[0].src, `${origin}/icon.png`);
    const listed = await send("/mcp", {method: "POST", headers, body: JSON.stringify({jsonrpc: "2.0", id: 2, method: "tools/list", params: {}})});
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).result.tools.length, 9);
    const other = origins.find(value => value !== origin);
    assert.equal((await mf.dispatchFetch(`${other}/mcp`, {method: "POST", headers, body: JSON.stringify({jsonrpc: "2.0", id: 3, method: "tools/list"})})).status, 401);
    const refreshed = await send("/oauth/token", {method: "POST", body: new URLSearchParams({grant_type: "refresh_token", client_id, refresh_token: token.refresh_token, resource: `${origin}/mcp`})});
    assert.equal(refreshed.status, 200);
    assert.ok((await refreshed.json()).access_token);
    console.log(`${origin}: discovery, PKCE authorization, token, refresh, nine tools, icon and audience isolation passed`);
  }
} finally {
  await mf.dispose();
}
