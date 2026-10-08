import {
  AuthorizationError,
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./knowledge-tools.js";
import { failureKey, authIsBlocked, recordAuthFailure, clearAuthFailures } from "./oauth-guards.js";

// Compiled per deployment: staging and production have distinct OAuth issuers.
declare const __MCP_ORIGIN__: string;
const MCP_ORIGIN = __MCP_ORIGIN__;
const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`;
const READ_SCOPE = "mcp:read";

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  WEKNORA_BASE_URL: string;
  WEKNORA_API_KEY: string;
  OWNER_AUTH_SECRET: string;
}

interface AuthProps {
  userId: string;
  role: "owner";
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(left)),
    crypto.subtle.digest("SHA-256", enc.encode(right)),
  ]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

class McpApiHandler extends WorkerEntrypoint<Env, AuthProps> {
  async fetch(request: Request): Promise<Response> {
    if (this.ctx.props.role !== "owner") {
      return new Response("Forbidden", { status: 403 });
    }
    if (new URL(request.url).pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    const server = createServer(this.env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  }
}

function oauthErrorResponse(error: AuthorizationError): Response {
  if (!error.redirectUri) {
    return new Response(error.description, { status: 400 });
  }
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect.toString(), 302);
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      // Anonymous liveness must not reveal upstream credential or tenant state.
      return Response.json({ ok: true, service: "weknora-cloudflare-mcp" },
        { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname !== "/authorize") {
      return new Response("Not found", { status: 404 });
    }

    let oauthRequest: AuthRequest;
    try {
      oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (error) {
      if (error instanceof AuthorizationError) return oauthErrorResponse(error);
      throw error;
    }

    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (!client) return new Response("Unknown OAuth client", { status: 400 });

    if (request.method === "GET") {
      const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>连接 WeKnora</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;max-width:540px;margin:60px auto;padding:0 20px;line-height:1.55}
    .card{border:1px solid #ddd;border-radius:16px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,.06)}
    input{width:100%;box-sizing:border-box;padding:12px;margin:10px 0 16px;border:1px solid #bbb;border-radius:8px}
    button{width:100%;padding:12px;border:0;border-radius:8px;background:#111;color:#fff;font-weight:600;cursor:pointer}
    .small{font-size:13px;color:#666}
  </style>
</head>
<body><div class="card">
  <h2>连接 WeKnora 云知识库</h2>
  <p>客户端：${escapeHtml(client.clientName ?? "ChatGPT")}</p>
  <p>请输入此应用单独设置的授权密码。不要输入 WeKnora API Key。</p>
  <p class="small">应用授权密码与 WeKnora API Key 分开保管；密码只用于验证所有者身份。</p>
  <form method="post" action="${escapeHtml(request.url)}">
    <input type="password" name="owner_secret" autocomplete="current-password" required>
    <button type="submit">授权只读访问</button>
  </form>
</div></body></html>`;
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const key = await failureKey(request);
    if (await authIsBlocked(env.OAUTH_KV, key)) {
      return new Response("Too many authentication failures", {
        status: 429, headers: { "Retry-After": "900", "Cache-Control": "no-store" },
      });
    }
    const form = await request.formData();
    const supplied = form.get("owner_secret");
    if (typeof supplied !== "string" || !env.OWNER_AUTH_SECRET) {
      await recordAuthFailure(env.OAUTH_KV, key);
      return new Response("Authorization failed", { status: 401 });
    }
    if (!(await secureEqual(supplied, env.OWNER_AUTH_SECRET))) {
      await recordAuthFailure(env.OAUTH_KV, key);
      return new Response("授权密码不正确。", { status: 401 });
    }
    await clearAuthFailures(env.OAUTH_KV, key);

    const allowed = new Set([READ_SCOPE, "offline_access"]);
    const grantedScopes = oauthRequest.scope.filter((scope) => allowed.has(scope));
    if (!grantedScopes.includes(READ_SCOPE)) grantedScopes.push(READ_SCOPE);

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: "weknora-owner",
      metadata: {
        clientName: client.clientName ?? "unknown",
      },
      scope: grantedScopes,
      props: {
        userId: "weknora-owner",
        role: "owner",
      },
    });

    return Response.redirect(redirectTo, 302);
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  scopesSupported: [READ_SCOPE, "offline_access"],
  requiredScopes: [READ_SCOPE],
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [MCP_ORIGIN],
    resource_name: "WeKnora Cloud MCP",
  },
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/oauth/register",
});
