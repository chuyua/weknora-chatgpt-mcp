import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildFolderTree } from "./folder-tree.ts";
import { registerWriteTools, isWriteReady } from "./write-tools.ts";

export interface ApiEnv {
  WEKNORA_BASE_URL: string;
  WEKNORA_API_KEY: string;
  WEKNORA_WRITE_API_KEY?: string;
  OWNER_AUTH_SECRET?: string;
  MCP_WRITE_ENABLED?: string;
  MCP_DRAFT_CONTRACT_VERIFIED?: string;
  WRITE_ALLOWED_KB_IDS?: string;
  WRITE_LEDGER?: D1Database;
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

export async function weknoraRequest(
  env: ApiEnv,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const base = (env.WEKNORA_BASE_URL || "https://weknora.weixin.qq.com/api/v1").replace(/\/$/, "");
  if (!base.startsWith("https://")) throw new Error("WeKnora upstream must use HTTPS");
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  const response = await fetch(`${base}/${path.replace(/^\//, "")}`, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      Accept: "application/json",
      "X-API-Key": env.WEKNORA_API_KEY,
      "X-Request-ID": crypto.randomUUID(),
      ...(bodyText === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: bodyText,
  });

  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > 3_000_000) throw new Error("WeKnora response exceeds size limit");
  const reader = response.body?.getReader();
  let raw = "";
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 3_000_000) {
          await reader.cancel("Response size limit");
          throw new Error("WeKnora response exceeds size limit");
        }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  let parsed: unknown = raw;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { message: raw.slice(0, 1000) };
    }
  }

  if (!response.ok) {
    // Never reflect raw upstream errors: they may contain credentials or private data.
    throw new Error(`WeKnora upstream HTTP ${response.status}`);
  }
  if (parsed && typeof parsed === "object" && "success" in parsed &&
    (parsed as { success: unknown }).success === false) {
    throw new Error("WeKnora upstream rejected request");
  }
  return parsed;
}

function unwrapData(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data: unknown }).data;
  }
  return value;
}

export function createServer(env: ApiEnv, options: {canWrite?:boolean} = {}): McpServer {
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
      query: z.string().trim().min(1).max(2000),
      knowledge_base_ids: z.array(z.string().uuid()).min(1).max(20).optional(),
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
    { knowledge_id: z.string().uuid() },
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

  server.tool(
    "get_knowledge_base",
    "Read details of a knowledge base.",
    { kb_id: z.string().uuid() },
    async ({ kb_id }) => jsonText(unwrapData(await weknoraRequest(env, "GET", `knowledge-bases/${encodeURIComponent(kb_id)}`))),
  );

  server.tool(
    "list_knowledge",
    "List knowledge items in a knowledge base with bounded pagination.",
    {
      kb_id: z.string().uuid(),
      page: z.number().int().min(1).max(100000).default(1),
      page_size: z.number().int().min(1).max(100).default(20),
    },
    async ({ kb_id, page, page_size }) => {
      const params = new URLSearchParams({ page: String(page), page_size: String(page_size) });
      const payload = unwrapData(await weknoraRequest(env, "GET", `knowledge-bases/${encodeURIComponent(kb_id)}/knowledge?${params}`));
      return jsonText({ kb_id, page, page_size, data: payload });
    },
  );

  server.tool(
    "list_chunks",
    "Read paginated chunks for a knowledge item.",
    {
      knowledge_id: z.string().uuid(),
      page: z.number().int().min(1).max(100000).default(1),
      page_size: z.number().int().min(1).max(100).default(20),
    },
    async ({ knowledge_id, page, page_size }) => {
      const params = new URLSearchParams({ page: String(page), page_size: String(page_size) });
      const payload = unwrapData(await weknoraRequest(env, "GET", `chunks/${encodeURIComponent(knowledge_id)}?${params}`));
      return jsonText({ knowledge_id, page, page_size, data: payload });
    },
  );

  server.tool(
    "list_knowledge_folders",
    "Read a knowledge-base folder tree. On managed cloud versions without the native endpoint, reconstruct it from paginated folder_path metadata.",
    { kb_id: z.string().uuid() },
    async ({ kb_id }) => {
      const prefix = `knowledge-bases/${encodeURIComponent(kb_id)}/knowledge`;
      try {
        const payload = unwrapData(await weknoraRequest(env, "GET", `${prefix}/folders`));
        return jsonText({ kb_id, folders: payload, source: "native" });
      } catch (error) {
        // A hosted cloud release may predate /knowledge/folders. Never
        // fall back on 401, 403 or other upstream errors.
        if (!(error instanceof Error) || error.message !== "WeKnora upstream HTTP 404") throw error;
      }
      const PAGE_SIZE = 100;
      const MAX_PAGES = 40;
      const PATH_FIELD = "folder_path";
      const paths: string[] = [];
      let scanned = 0;
      let complete = false;
      for (let page = 1; page <= MAX_PAGES; page += 4) {
        const pages = await Promise.all(
          Array.from({ length: Math.min(4, MAX_PAGES - page + 1) }, (_, i) => page + i).map(async (number) => {
            const params = new URLSearchParams({ page: String(number), page_size: String(PAGE_SIZE) });
            const response = await weknoraRequest(env, "GET", `${prefix}?${params}`);
            const data = unwrapData(response);
            const entries = Array.isArray(data)
              ? data
              : data && typeof data === "object" && "items" in data
                ? (data as { items: unknown }).items
                : undefined;
            if (!Array.isArray(entries)) throw new Error("Unexpected WeKnora knowledge list response");
            return entries;
          }),
        );
        for (const entries of pages) {
          scanned += entries.length;
          for (const item of entries) {
            if (item && typeof item === "object" && PATH_FIELD in item) {
              const path = (item as Record<string, unknown>)[PATH_FIELD];
              if (typeof path === "string") paths.push(path);
            }
          }
          if (entries.length < PAGE_SIZE) { complete = true; break; }
        }
        if (complete) break;
      }
      if (!complete) throw new Error("Folder list exceeds bounded scan; refusing incomplete tree");
      return jsonText({
        kb_id,
        folders: buildFolderTree(paths),
        source: "derived_from_knowledge",
        scanned_knowledge: scanned,
        complete: true,
      });
    },
  );

  server.tool(
    "get_chunk_by_id",
    "Read a single knowledge chunk by its ID.",
    { chunk_id: z.string().uuid() },
    async ({ chunk_id }) => {
      const payload = unwrapData(await weknoraRequest(env, "GET", `chunks/by-id/${encodeURIComponent(chunk_id)}`));
      return jsonText(payload);
    },
  );

  if (options.canWrite === true && isWriteReady(env)) registerWriteTools(server,env,weknoraRequest);
  return server;
}

