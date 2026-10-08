import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/knowledge-tools.ts";
import { isWriteReady } from "../src/write-tools.ts";
import { createTestD1 } from "./support/sqlite-d1.mjs";

const kb = "54753f2f-701a-4123-aaa6-d921108b0706";
const other = "75dd92e0-7d69-4aec-acd7-133d16fac35e";
const doc = "a9c354dc-166e-41a4-8d74-bd1da6b0040f";
const updatedAt = "2026-10-07T18:00:00Z";
const ledger = createTestD1();
const createId = "1b6c1f58-f203-4e55-91da-99d47118af11";
const configured = {
 WEKNORA_BASE_URL:"https://mock.weknora.invalid/api/v1",
 WEKNORA_API_KEY:"test-read-secret",
 WEKNORA_WRITE_API_KEY:"test-write-secret-not-real",
 OWNER_AUTH_SECRET:"independent-owner-secret-long-enough",
 WRITE_ALLOWED_KB_IDS:kb,
 MCP_WRITE_ENABLED:"true",
 MCP_DRAFT_CONTRACT_VERIFIED:"true",
 WRITE_LEDGER:ledger.d1,
};
async function withMcp(env,canWrite,run) {
 const server=createServer(env,{canWrite});
 const client=new Client({name:"phase-b-tests",version:"1.0"},{capabilities:{}});
 const [left,right]=InMemoryTransport.createLinkedPair();
 await server.connect(right);
 await client.connect(left);
 try { return await run(client); } finally {await client.close();await server.close();}
}
const toolNames=async(client)=>(await client.listTools()).tools.map(x=>x.name);
const resultJson=(res)=>JSON.parse(res.content[0].text);

test("default production config never exposes write tools, even if requested",async()=>{
 const base={...configured,MCP_WRITE_ENABLED:"false"};
 assert.equal(isWriteReady(base),false);
 assert.equal(isWriteReady({...configured,WEKNORA_WRITE_API_KEY:configured.WEKNORA_API_KEY}),false);
 assert.equal(isWriteReady({...configured,WRITE_ALLOWED_KB_IDS:""}),false);
 assert.equal(isWriteReady({...configured,OWNER_AUTH_SECRET:""}),false);
 for(const e of [base,{...configured,WEKNORA_WRITE_API_KEY:configured.WEKNORA_API_KEY},{...configured,WRITE_ALLOWED_KB_IDS:""}]){
  await withMcp(e,true,async c=>{
   const names=await toolNames(c);
   assert.equal(names.length,9);
   assert.equal(names.includes("create_manual_knowledge"),false);
  });
 }
 await withMcp(configured,false,async c=>{
   assert.equal((await toolNames(c)).length,9);
 });
});

test("write preview and execute require separate authorization, explicit confirmation, and allowed KB",async(t)=>{
 const seen=[];
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async (url,init)=>{
  seen.push({url:String(url),method:init.method,key:init.headers["X-API-Key"],body:init.body});
  const data=init.method==="GET"
    ? {id:doc,knowledge_base_id:kb,type:"manual",enable_status:"disabled",parse_status:"draft",metadata:{status:"draft",format:"markdown"}}
    : {id:doc};
  return new Response(JSON.stringify({success:true,data}),{status:200,headers:{"Content-Type":"application/json"}});
 };
 t.after(()=>globalThis.fetch=originalFetch);
 await withMcp(configured,true,async c=>{
  const names=await toolNames(c);
  assert.equal(names.length,13);
  assert.ok(names.includes("create_manual_knowledge"));
  const args={kb_id:kb,title:"测试草稿",content:"## Markdown"};
  const preview=resultJson(await c.callTool({name:"create_manual_knowledge",arguments:args}));
  assert.equal(preview.performed,false);
  assert.equal(seen.length,0);
  const notAllowed=await c.callTool({name:"create_manual_knowledge",arguments:{...args,kb_id:other,mode:"execute",confirm:true}});
  assert.equal(notAllowed.isError,true);
  assert.equal(seen.length,0);
  const unconfirmed=await c.callTool({name:"create_manual_knowledge",arguments:{...args,mode:"execute"}});
  assert.equal(unconfirmed.isError,true);
  assert.equal(seen.length,0);
  const done=resultJson(await c.callTool({name:"create_manual_knowledge",arguments:{...args,mode:"execute",confirm:true,operation_id:createId}}));
  assert.equal(done.performed,true);
  assert.equal(seen.length,2);
  assert.equal(seen[0].method,"POST");
  assert.equal(seen[1].method,"GET");
  assert.equal(new URL(seen[0].url).pathname,"/api/v1/knowledge-bases/"+kb+"/knowledge/manual");
  assert.equal(seen[0].key,configured.WEKNORA_WRITE_API_KEY);
  assert.equal(JSON.parse(seen[0].body).status,"draft");
  const replay=await c.callTool({name:"create_manual_knowledge",arguments:{...args,mode:"execute",confirm:true,operation_id:createId}});
  assert.equal(replay.isError,true);
  const duplicate=await c.callTool({name:"create_manual_knowledge",arguments:{...args,mode:"execute",confirm:true,operation_id:"1b6c1f58-f203-4e55-91da-99d47118af12"}});
  assert.equal(duplicate.isError,true);
  assert.equal(seen.length,2);
  const status=resultJson(await c.callTool({name:"get_write_operation",arguments:{operation_id:createId}}));
  assert.equal(status.operation.state,"success");
 });
});

test("manual edit denies wrong type/KB/stale update and never writes on preview",async(t)=>{
 const seen=[];
 const originalFetch=globalThis.fetch;
 let type="manual",timestamp=updatedAt,targetKb=kb,manualStatus="draft";
 globalThis.fetch=async (url,init)=>{
  seen.push({url:String(url),method:init.method,key:init.headers["X-API-Key"],body:init.body});
  const response=init.method==="GET" ? {id:doc,knowledge_base_id:targetKb,type,updated_at:timestamp,enable_status:"disabled",parse_status:"draft",metadata:{format:"markdown",status:manualStatus,version:1}} : {id:doc,updated_at:"new"};
  return new Response(JSON.stringify({success:true,data:response}),{status:200,headers:{"Content-Type":"application/json"}});
 };
 t.after(()=>globalThis.fetch=originalFetch);
 await withMcp(configured,true,async c=>{
  const args={kb_id:kb,knowledge_id:doc,title:"修改",content:"new",expected_updated_at:updatedAt};
  const preview=resultJson(await c.callTool({name:"update_manual_knowledge",arguments:args}));
  assert.equal(preview.performed,false);
  assert.equal(seen.length,1);
  assert.equal(seen[0].key,configured.WEKNORA_API_KEY);
  timestamp="stale";
  let denied=await c.callTool({name:"update_manual_knowledge",arguments:{...args,content:"stale1",mode:"execute",confirm:true,operation_id:"3b6c1f58-f203-4e55-91da-99d47118af11"}});
  assert.equal(denied.isError,true);
  timestamp=updatedAt;
  type="file";
  denied=await c.callTool({name:"update_manual_knowledge",arguments:{...args,content:"wrongtype",mode:"execute",confirm:true,operation_id:"3b6c1f58-f203-4e55-91da-99d47118af12"}});
  assert.equal(denied.isError,true);
  type="manual";targetKb=other;
  denied=await c.callTool({name:"update_manual_knowledge",arguments:{...args,content:"wrongkb",mode:"execute",confirm:true,operation_id:"3b6c1f58-f203-4e55-91da-99d47118af13"}});
  assert.equal(denied.isError,true);
  targetKb=kb;
  manualStatus="publish";
  denied=await c.callTool({name:"update_manual_knowledge",arguments:{...args,mode:"preview"}});
  assert.equal(denied.isError,true);
  manualStatus="draft";
  denied=await c.callTool({name:"update_manual_knowledge",arguments:{...args,mode:"execute",confirm:false}});
  assert.equal(denied.isError,true);
  assert.ok(seen.every(x=>x.method==="GET"));
  const updated=resultJson(await c.callTool({name:"update_manual_knowledge",arguments:{...args,mode:"execute",confirm:true,operation_id:"3b6c1f58-f203-4e55-91da-99d47118af14"}}));
  assert.equal(updated.performed,true);
  const call=seen.at(-2);
  assert.equal(call.method,"PUT");
  assert.equal(seen.at(-1).method,"GET");
  assert.equal(new URL(call.url).pathname,"/api/v1/knowledge/manual/"+doc);
  assert.equal(call.key,configured.WEKNORA_WRITE_API_KEY);
  assert.equal(JSON.parse(call.body).status,"draft");
 });
});
