import {
  AuthorizationError,
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const MCP_ORIGIN = "https://weknora-mcp-chuyuai.pages.dev";
const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`;
const READ_SCOPE = "mcp:read";

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  WEKNORA_BASE_URL: string;
  WEKNORA_API_KEY: string;
  WEKNORA_APP_ID: string;
}

interface AuthProps {
  userId: string;
  role: "owner";
}

function jsonText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
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

async function buildGatewayHeaders(
  env: Env,
  requestBody: string,
  encoding: "hex" | "base64" | "base64hex",
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const requestId = crypto.randomUUID();
  const message = `${timestamp}\n${nonce}\n${requestId}\n${requestBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.WEKNORA_API_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  const hexSignature = Array.from(signatureBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const signature =
    encoding === "hex"
      ? hexSignature
      : encoding === "base64"
        ? btoa(String.fromCharCode(...signatureBytes))
        : btoa(hexSignature);

  return {
    Accept: "application/json",
    "X-APPID": env.WEKNORA_APP_ID,
    "X-Request-ID": requestId,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": signature,
  };
}

async function weknoraRequest(
  env: Env,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const base = (env.WEKNORA_BASE_URL || "https://weknora.weixin.qq.com/api/v1").replace(/\/$/, "");
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const encodings: Array<"hex" | "base64" | "base64hex"> = ["hex", "base64", "base64hex"];
  let lastResponse: Response | null = null;
  let raw = "";

  for (const encoding of encodings) {
    const response = await fetch(`${base}/${path.replace(/^\//, "")}`, {
      method,
      headers: {
        ...(await buildGatewayHeaders(env, bodyText, encoding)),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : bodyText,
    });
    lastResponse = response;
    raw = await response.text();
    if (response.status !== 401) break;
  }

  if (!lastResponse) {
    throw new Error("WeKnora request failed before receiving a response");
  }
  let parsed: unknown = raw;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { message: raw.slice(0, 1000) };
    }
  }

  if (!lastResponse.ok) {
    throw new Error(`WeKnora HTTP ${lastResponse.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function unwrapData(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data: unknown }).data;
  }
  return value;
}

function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: "WeKnora Cloud MCP",
    version: "1.0.0",
  });

  server.tool(
    "weknora_status",
    "Check cloud connectivity to WeKnora without exposing credentials.",
    {},
    async () => {
      const result: Record<string, unknown> = {
        base_url: env.WEKNORA_BASE_URL,
        api_key_configured: Boolean(env.WEKNORA_API_KEY),
        reachable: false,
      };
      try {
        const payload = unwrapData(await weknoraRequest(env, "GET", "knowledge-bases"));
        const list = Array.isArray(payload)
          ? payload
          : payload && typeof payload === "object" && "items" in payload
            ? (payload as { items: unknown }).items
            : payload && typeof payload === "object" && "list" in payload
              ? (payload as { list: unknown }).list
              : undefined;
        result.reachable = true;
        result.knowledge_base_count = Array.isArray(list) ? list.length : null;
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
      return jsonText(result);
    },
  );

  server.tool(
    "list_knowledge_bases",
    "List WeKnora knowledge bases visible to the configured cloud credential.",
    {},
    async () => {
      const payload = unwrapData(await weknoraRequest(env, "GET", "knowledge-bases"));
      return jsonText({ knowledge_bases: payload });
    },
  );

  server.tool(
    "search_knowledge",
    "Search WeKnora knowledge. Optionally restrict the search to knowledge-base IDs.",
    {
      query: z.string().min(1),
      knowledge_base_ids: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(30).default(10),
    },
    async ({ query, knowledge_base_ids, limit }) => {
      const body: Record<string, unknown> = {
        query,
        match_count: limit,
      };
      if (knowledge_base_ids?.length) body.knowledge_base_ids = knowledge_base_ids;
      const payload = unwrapData(
        await weknoraRequest(
          env,
          "POST",
          "knowledge-search?resource_urls=public",
          body,
        ),
      );
      return jsonText({ query, results: payload });
    },
  );

  server.tool(
    "get_knowledge",
    "Read one WeKnora knowledge item by ID.",
    { knowledge_id: z.string().min(1) },
    async ({ knowledge_id }) => {
      const encoded = encodeURIComponent(knowledge_id);
      const payload = unwrapData(
        await weknoraRequest(
          env,
          "GET",
          `knowledge/${encoded}?resource_urls=public`,
        ),
      );
      return jsonText(payload);
    },
  );

  return server;
}

class McpApiHandler extends WorkerEntrypoint<Env, AuthProps> {
  async fetch(request: Request): Promise<Response> {
    if (this.ctx.props.role !== "owner") {
      return new Response("Forbidden", { status: 403 });
    }
    const server = createServer(this.env);
    return createMcpHandler(server, {
      route: "/mcp",
      enableJsonResponse: true,
    })(request, this.env, this.ctx as unknown as ExecutionContext);
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
      return Response.json({ ok: true, service: "weknora-cloudflare-mcp" });
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
  <p>请输入当前有效的 WeKnora API Key 完成本人授权。</p>
  <p class="small">Key 仅在此 Cloudflare Worker 内与 Secret 做哈希等时比较，不会返回给 ChatGPT，也不会写入 OAuth Token、日志或 GitHub。</p>
  <form method="post" action="${escapeHtml(request.url)}">
    <input type="password" name="api_key" autocomplete="current-password" required>
    <button type="submit">授权只读访问</button>
  </form>
</div></body></html>`;
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const form = await request.formData();
    const supplied = form.get("api_key");
    if (typeof supplied !== "string" || !env.WEKNORA_API_KEY) {
      return new Response("Authorization failed", { status: 401 });
    }
    if (!(await secureEqual(supplied, env.WEKNORA_API_KEY))) {
      return new Response("WeKnora API Key 不正确。", { status: 401 });
    }

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
