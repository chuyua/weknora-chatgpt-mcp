import test from "node:test";
import assert from "node:assert/strict";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "../src/knowledge-tools.ts";

function rpc(method, id, params={}) {
  return new Request("https://local.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({jsonrpc:"2.0",id,method,params})
  });
}
async function once(req) {
  const s=createServer({WEKNORA_BASE_URL:"https://mock.invalid/api/v1",WEKNORA_API_KEY:"mock"});
  const t=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await s.connect(t);
  const response=await t.handleRequest(req);
  await s.close();
  return response;
}
test("stateless Web Standards HTTP transport initializes MCP",async()=>{
 const req=rpc("initialize",1,{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"phasea-test",version:"1.0"}});
 const r=await once(req);
 assert.equal(r.status,200);
 const x=await r.json();
 assert.equal(x.jsonrpc,"2.0");
 assert.equal(x.id,1);
 assert.equal(typeof x.result.serverInfo.name,"string");
});
test("stateless Web Standards HTTP transports MCP tools/list",async()=>{
 const r=await once(rpc("tools/list",2));
 assert.equal(r.status,200);
 const x=await r.json();
 assert.equal(x.id,2);
 assert.equal(x.result.tools.length,9);
});
