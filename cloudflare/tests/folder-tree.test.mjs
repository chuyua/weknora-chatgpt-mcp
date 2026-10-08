import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/knowledge-tools.ts";
import { buildFolderTree } from "../src/folder-tree.ts";

const KB = "75dd92e0-7d69-4aec-acd7-133d16fac35e";
const env = { WEKNORA_BASE_URL: "https://mock.weknora.invalid/api/v1", WEKNORA_API_KEY: "test-not-a-real-key" };

async function invokeFolderTool(fetchHandler) {
  const old = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({path:u.pathname + u.search,method:init.method});
    return fetchHandler(u);
  };
  const server = createServer(env);
  const client = new Client({name:"folder-compat-test",version:"1.0"},{capabilities:{}});
  const [ct,st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    const res = await client.callTool({name:"list_knowledge_folders",arguments:{kb_id:KB}});
    let obj;
    try { obj = JSON.parse(res.content[0].text); }
    catch { obj = { error_message: res.content[0].text }; }
    return {res,obj,calls};
  } finally {
    globalThis.fetch = old;
    await client.close();
    await server.close();
  }
}
const json=(data,status=200) => new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json"}});

test("folder tree derives nested paths with accurate direct and recursive counts",()=>{
  const roots = buildFolderTree(["batches/007C","batches/007C/evidence-cards","ops","batches/007C/evidence-cards","","../unsafe"]);
  assert.equal(roots.length,2);
  const batch = roots.find(x=>x.name==="batches");
  assert.equal(batch.total_count,3);
  const b = batch.children[0];
  assert.deepEqual([b.document_count,b.total_count],[1,3]);
  assert.equal(b.children[0].document_count,2);
  assert.equal(roots.find(x=>x.name==="ops").document_count,1);
});
test("native folder route is retained when supported",async()=>{
  const x=await invokeFolderTool(u=>{
    assert.equal(u.pathname,"/api/v1/knowledge-bases/"+KB+"/knowledge/folders");
    return json({success:true,data:[{path:"native-dir",name:"native-dir",children:[]}]});
  });
  assert.equal(x.res.isError,undefined);
  assert.equal(x.obj.source,"native");
  assert.equal(x.obj.folders[0].path,"native-dir");
  assert.equal(x.calls.length,1);
});
test("hosted cloud HTTP 404 falls back to paginated metadata, without reading content",async()=>{
  const x=await invokeFolderTool(u=>{
    if(u.pathname.endsWith("/knowledge/folders")) return json({message:"Not Found"},404);
    assert.equal(u.pathname,"/api/v1/knowledge-bases/"+KB+"/knowledge");
    const page=Number(u.searchParams.get("page"));
    assert.equal(u.searchParams.get("page_size"),"100");
    const entries=page===1 ? Array.from({length:100},(_,i)=>({id:String(i),folder_path:i%2?"batches/007C":"ops"}))
      :page===2 ? [{id:"last1",folder_path:"batches/007C/evidence-cards"},{id:"last2",folder_path:""}]
      :[];
    return json({success:true,data:entries,total:102});
  });
  assert.equal(x.res.isError,undefined);
  assert.equal(x.obj.source,"derived_from_knowledge");
  assert.equal(x.obj.complete,true);
  assert.equal(x.obj.scanned_knowledge,102);
  assert.deepEqual(x.obj.folders.map(y=>y.name),["batches","ops"]);
  assert.equal(x.obj.folders.find(y=>y.name==="batches").total_count,51);
  assert.equal(x.obj.folders.find(y=>y.name==="ops").document_count,50);
  assert.equal(x.calls.length,5);
  assert.ok(x.calls.every(y=>y.method==="GET"));
});
test("401 from native folder route is not silently bypassed",async()=>{
  const x=await invokeFolderTool(u=>json({secret:"private"},401));
  assert.equal(x.res.isError,true);
  assert.equal(x.calls.length,1);
  assert.ok(!JSON.stringify(x.res).includes("private"));
});
