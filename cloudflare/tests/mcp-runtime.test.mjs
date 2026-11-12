import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/knowledge-tools.ts";

test("live MCP tool handshake and mocked official WeKnora API", async (t) => {
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = new URL(url);
    seen.push({ path: target.pathname + target.search, method: init.method, headers: init.headers, body: init.body });
    return new Response(JSON.stringify({ success: true, data: { path: target.pathname, ok: true } }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const env = { WEKNORA_BASE_URL: "https://mock.weknora.invalid/api/v1", WEKNORA_API_KEY: "test-secret-do-not-output" };
  const icons = [{src: "https://weknora.example/icon.png", mimeType: "image/png", sizes: ["256x256"]}];
  const server = createServer(env, {icons});
  const client = new Client({ name: "phasea-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  assert.deepEqual(client.getServerVersion().icons, icons, "MCP initialize advertises the public icon");
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(x=>x.name).sort(),[
    "get_chunk_by_id","get_knowledge","get_knowledge_base","list_chunks","list_knowledge","list_knowledge_bases","list_knowledge_folders","search_knowledge","weknora_status"
  ].sort());

  const uuid = "75dd92e0-7d69-4aec-acd7-133d16fac35e";
  const good = await client.callTool({name:"get_knowledge_base",arguments:{kb_id:uuid}});
  assert.equal(good.isError,undefined);
  assert.equal(seen.at(-1).path, "/api/v1/knowledge-bases/"+uuid);
  assert.equal(seen.at(-1).method,"GET");
  assert.equal(seen.at(-1).headers["X-API-Key"],env.WEKNORA_API_KEY);

  await client.callTool({ name:"list_knowledge",arguments:{ kb_id:uuid, page:3, page_size:12 }});
  assert.equal(seen.at(-1).path, "/api/v1/knowledge-bases/"+uuid+"/knowledge?page=3&page_size=12");
  await client.callTool({ name:"list_chunks",arguments:{knowledge_id:uuid,page:2,page_size:9}});
  assert.equal(seen.at(-1).path, "/api/v1/chunks/"+uuid+"?page=2&page_size=9");
  await client.callTool({name:"list_knowledge_folders",arguments:{kb_id:uuid}});
  assert.equal(seen.at(-1).path,"/api/v1/knowledge-bases/"+uuid+"/knowledge/folders");
  await client.callTool({name:"get_chunk_by_id",arguments:{chunk_id:uuid}});
  assert.equal(seen.at(-1).path,"/api/v1/chunks/by-id/"+uuid);

  const before = seen.length;
  const bad = await client.callTool({name:"list_knowledge",arguments:{kb_id:uuid,page:0,page_size:999999}});
  assert.equal(bad.isError,true);
  assert.equal(seen.length,before,"Invalid parameters must not reach WeKnora");

  const status = await client.callTool({name:"weknora_status",arguments:{}});
  assert.equal(status.isError,undefined);
  assert.equal(JSON.stringify(status).includes(env.WEKNORA_API_KEY),false);
  await client.callTool({name:"search_knowledge",arguments:{query:"色调平衡",knowledge_base_ids:[uuid],limit:7}});
  assert.equal(seen.at(-1).method,"POST");
  assert.equal(seen.at(-1).path,"/api/v1/knowledge-search?resource_urls=public");
  assert.deepEqual(JSON.parse(seen.at(-1).body),{query:"色调平衡",match_count:7,knowledge_base_ids:[uuid]});

  const names = tools.tools.map(x=>x.name);
  assert.equal(names.some(x=>/delete|create|upload|update/i.test(x)),false);
});
