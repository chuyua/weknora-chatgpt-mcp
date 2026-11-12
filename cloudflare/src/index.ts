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
import { isWriteReady, WRITE_SCOPE } from "./write-tools.ts";
import { decideScopes } from "./oauth-scope-policy.ts";

// Compiled per deployment: staging and production have distinct OAuth issuers.
declare const __MCP_ORIGIN__: string;
const MCP_ORIGIN = __MCP_ORIGIN__;
const CUSTOM_ORIGIN = "https://weknora.xzdq.eu.org";
const READ_SCOPE = "mcp:read";

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  WEKNORA_BASE_URL: string;
  WEKNORA_API_KEY: string;
  OWNER_AUTH_SECRET: string;
  WEKNORA_WRITE_API_KEY?: string;
  MCP_WRITE_ENABLED?: string;
  MCP_DRAFT_CONTRACT_VERIFIED?: string;
  WRITE_ALLOWED_KB_IDS?: string;
  WRITE_LEDGER?: D1Database;
}

interface AuthProps {
  userId: string;
  role: "owner";
  grantedScopes?: string[];
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
    const canWrite = isWriteReady(this.env) && this.ctx.props.grantedScopes?.includes(WRITE_SCOPE) === true;
    const server = createServer(this.env, {canWrite, icons: [{src: `${new URL(request.url).origin}/icon.png`, mimeType: "image/png", sizes: ["256x256"]}]});
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
      const independentLogin = Boolean(env.OWNER_AUTH_SECRET);
      const loginField = independentLogin ? "owner_secret" : "api_key";
      const loginInstructions = independentLogin
        ? "请输入单独配置的应用授权密码（不是 WeKnora API Key）。"
        : "请使用此前的 WeKnora API Key 授权；生产环境尚未迁移到独立授权密码。不要把密钥发送到聊天中。";
      const showWriteApproval = isWriteReady(env) && oauthRequest.scope.includes(WRITE_SCOPE);
      const writeApproval = showWriteApproval
        ? '<label><input type="checkbox" name="write_consent" value="yes" required> 我明确允许为配置白名单中的知识库创建或修改 Markdown 草稿</label>'
        : "";
      const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>连接 WeKnora</title>
  <link rel="icon" type="image/png" sizes="256x256" href="/icon.png">
  <link rel="apple-touch-icon" href="/icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;max-width:540px;margin:60px auto;padding:0 20px;line-height:1.55}
    .card{border:1px solid #ddd;border-radius:16px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,.06)}
    input{width:100%;box-sizing:border-box;padding:12px;margin:10px 0 16px;border:1px solid #bbb;border-radius:8px}
    button{width:100%;padding:12px;border:0;border-radius:8px;background:#111;color:#fff;font-weight:600;cursor:pointer}
    .small{font-size:13px;color:#666}
  </style>
</head>
<body><div class="card">
  <img src="/icon.png" alt="WeKnora" width="64" height="64" style="display:block;margin:0 0 16px;border-radius:14px">
  <h2>连接 WeKnora 云知识库</h2>
  <p>客户端：${escapeHtml(client.clientName ?? "ChatGPT")}</p>
  <p>${escapeHtml(loginInstructions)}</p>
  <p class="small">此页面只用于所有者授权；升级不改变已签发的有效访问令牌。</p>
  <form method="post" action="${escapeHtml(request.url)}">
    <input type="password" name="${loginField}" autocomplete="current-password" required>
    ${writeApproval}
    <button type="submit">${showWriteApproval ? "确认授权访问" : "授权只读访问"}</button>
  </form>
</div></body></html>`;
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          // Chromium checks form-action against redirects too. OAuth success
          // returns 302 to the validated OAuth client redirect URI: permit it.
          "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com https://chat.openai.com https://claude.ai; frame-ancestors 'none'; base-uri 'none'",
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
    // Preserve previous production authorization until OWNER_AUTH_SECRET is set.
    // Staging does not inherit any secret from production.
    const independentLogin = Boolean(env.OWNER_AUTH_SECRET);
    const expectedSecret = independentLogin ? env.OWNER_AUTH_SECRET : env.WEKNORA_API_KEY;
    const supplied = form.get(independentLogin ? "owner_secret" : "api_key");
    if (typeof supplied !== "string" || !expectedSecret) {
      await recordAuthFailure(env.OAUTH_KV, key);
      return new Response("Authorization failed", { status: 401 });
    }
    if (!(await secureEqual(supplied, expectedSecret))) {
      await recordAuthFailure(env.OAUTH_KV, key);
      return new Response("授权密码不正确。", { status: 401 });
    }
    await clearAuthFailures(env.OAUTH_KV, key);

    const writeApproved = isWriteReady(env) && oauthRequest.scope.includes(WRITE_SCOPE)
      && form.get("write_consent") === "yes";
    const grantedScopes = decideScopes(oauthRequest.scope, {
      writeReady: isWriteReady(env),
      writeConsent: writeApproved,
    });

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
        grantedScopes,
      },
    });

    return Response.redirect(redirectTo, 302);
  },
};

function createOAuthProvider(origin: string) {
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: McpApiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    scopesSupported: [READ_SCOPE, WRITE_SCOPE, "offline_access"],
    requiredScopes: [READ_SCOPE],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      resource_name: "WeKnora Cloud MCP",
    },
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: "/oauth/register",
  });
}

// Preserve the published pages.dev issuer and grants while adding the custom host.
const originalProvider = createOAuthProvider(MCP_ORIGIN);
const customProvider = createOAuthProvider(CUSTOM_ORIGIN);
export default {
  fetch(request, env, ctx) {
    const provider = new URL(request.url).origin === CUSTOM_ORIGIN ? customProvider : originalProvider;
    // The library caches issuer-specific OAuth helpers on env. Keep them request-local.
    return provider.fetch(request, {...env}, ctx);
  },
} satisfies ExportedHandler<Env>;
