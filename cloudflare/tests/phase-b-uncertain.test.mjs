import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/knowledge-tools.ts";
import { createTestD1 } from "./support/sqlite-d1.mjs";

const kb="54753f2f-701a-4123-aaa6-d921108b0706";
const doc="a9c354dc-166e-41a4-8d74-bd1da6b0040f";
const ids=[
  "8b6c1f58-f203-4e55-91da-99d47118af10",
  "8b6c1f58-f203-4e55-91da-99d47118af11",
  "8b6c1f58-f203-4e55-91da-99d47118af12",
  "8b6c1f58-f203-4e55-91da-99d47118af13",
];
const updated="2026-10-07T18:00:00Z";
function getEnv(ledger) {return {
  WEKNORA_BASE_URL:"https://mock.weknora.invalid/api/v1",
  WEKNORA_API_KEY:"readonly-mock-credential",
  WEKNORA_WRITE_API_KEY:"write-mock-credential",
  OWNER_AUTH_SECRET:"long-independent-owner-password-for-tests",
  MCP_WRITE_ENABLED:"true",
  MCP_DRAFT_CONTRACT_VERIFIED:"true",
  WRITE_ALLOWED_KB_IDS:kb,
  WRITE_LEDGER:ledger.d1,
};}
async function connect(env,fn){
  const server=createServer(env,{canWrite:true});
  const client=new Client({name:"write-failure-test",version:"1.0"},{capabilities:{}});
  const [ct,st]=InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {return await fn(client);}finally{await client.close();await server.close();}
}
const parsed=(reply)=>JSON.parse(reply.content[0].text);
const response=(value)=>new Response(JSON.stringify({success:true,data:value}),{status:200,headers:{"Content-Type":"application/json"}});

test("ambiguous create timeout becomes uncertain, blocks same-ID and same-content retries",async(t)=>{
  const db=createTestD1();t.after(db.close);
  let dispatched=0; const orig=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{
    if(init.method==="POST"){dispatched++; throw new Error("Simulated network timeout after upstream may commit");}
    throw new Error("Unexpected request");
  };
  t.after(()=>globalThis.fetch=orig);
  await connect(getEnv(db),async(client)=>{
    const base={kb_id:kb,title:"uncertain",content:"protected markdown body",mode:"execute",confirm:true};
    const first=await client.callTool({name:"create_manual_knowledge",arguments:{...base,operation_id:ids[0]}});
    assert.equal(first.isError,true);
    let state=parsed(await client.callTool({name:"get_write_operation",arguments:{operation_id:ids[0]}}));
    assert.equal(state.operation.state,"uncertain");
    const inspection=parsed(await client.callTool({name:"inspect_write_reconciliation",arguments:{operation_id:ids[0]}}));
    assert.equal(inspection.remote_check,"no_upstream_id");
    assert.equal(inspection.requires_manual_reconciliation,true);
    assert.ok(state.audit_events.some(x=>x.event==="uncertain"));
    assert.equal(dispatched,1);
    assert.equal((await client.callTool({name:"create_manual_knowledge",arguments:{...base,operation_id:ids[0]}})).isError,true);
    assert.equal((await client.callTool({name:"create_manual_knowledge",arguments:{...base,operation_id:ids[1]}})).isError,true);
    assert.equal(dispatched,1,"Must never blindly resubmit a potentially committed write");
    const audit=JSON.stringify(db.sqlite.prepare("SELECT * FROM weknora_write_audit").all());
    assert.ok(!audit.includes("protected markdown body"));
    assert.ok(!audit.includes(getEnv(db).WEKNORA_WRITE_API_KEY));
  });
});

test("ambiguous update retains document lock, disallows alternate content update",async(t)=>{
  const db=createTestD1();t.after(db.close);
  let sent=0;const orig=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{
    if(init.method==="GET")return response({id:doc,type:"manual",knowledge_base_id:kb,updated_at:updated,enable_status:"disabled",parse_status:"draft",metadata:{status:"draft",format:"markdown",version:1}});
    if(init.method==="PUT"){sent++;throw new Error("Simulated uncertain write outcome");}
    throw new Error("Unexpected method");
  };
  t.after(()=>globalThis.fetch=orig);
  await connect(getEnv(db),async(client)=>{
    const first={kb_id:kb,knowledge_id:doc,title:"a",content:"hello",expected_updated_at:updated,mode:"execute",confirm:true,operation_id:ids[0]};
    const fail=await client.callTool({name:"update_manual_knowledge",arguments:first});
    assert.equal(fail.isError,true);
    const journal=parsed(await client.callTool({name:"get_write_operation",arguments:{operation_id:ids[0]}}));
    assert.equal(journal.operation.state,"uncertain");
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM weknora_write_locks").get().n,1);
    const second=await client.callTool({name:"update_manual_knowledge",arguments:{...first,content:"different",operation_id:ids[1]}});
    assert.equal(second.isError,true);
    assert.equal(sent,1);
    assert.equal(parsed(await client.callTool({name:"get_write_operation",arguments:{operation_id:ids[1]}})).operation.state,"rejected");
  });
});

test("published state after a requested draft is never reported as success",async(t)=>{
  const db=createTestD1();t.after(db.close);
  let postCount=0,readCount=0;
  const old=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{
    if(init.method==="POST"){postCount++;return response({id:doc});}
    if(init.method==="GET"){
      readCount++;
      return response({id:doc,knowledge_base_id:kb,type:"manual",metadata:{status:"publish",version:1}});
    }
    throw new Error("Unexpected request");
  };
  t.after(()=>globalThis.fetch=old);
  await connect(getEnv(db),async(client)=>{
    const args={kb_id:kb,title:"unexpected publish",content:"sandbox example",mode:"execute",confirm:true,operation_id:ids[2]};
    const result=await client.callTool({name:"create_manual_knowledge",arguments:args});
    assert.equal(result.isError,true);
    assert.equal(postCount,1);
    assert.equal(readCount,1);
    const logged=parsed(await client.callTool({name:"get_write_operation",arguments:{operation_id:ids[2]}}));
    assert.equal(logged.operation.state,"uncertain");
    assert.equal(logged.operation.result_id,doc,"Persist upstream ID for manual reconciliation");
    const inspected=parsed(await client.callTool({name:"inspect_write_reconciliation",arguments:{operation_id:ids[2]}}));
    assert.equal(inspected.remote_check,"draft_contract_not_verified");
    assert.equal(inspected.requires_manual_reconciliation,true);
    assert.ok(!JSON.stringify(inspected).includes("sandbox example"));
    assert.ok(logged.audit_events.some(event=>event.event==="sent"&&event.code==="upstream_result_identified"));
    assert.ok(logged.audit_events.some(event=>event.event==="uncertain"&&event.code==="draft_contract_violation"));
    assert.equal((await client.callTool({name:"create_manual_knowledge",arguments:args})).isError,true);
    assert.equal(postCount,1);
  });
});

test("readback outage retains the acknowledged upstream ID and prevents blind retry",async(t)=>{
  const db=createTestD1();t.after(db.close);
  let writes=0,readbacks=0;
  const original=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{
    if(init.method==="POST"){writes++;return response({id:doc});}
    if(init.method==="GET"){readbacks++;throw new Error("Readback service unavailable");}
    throw new Error("Unexpected method");
  };
  t.after(()=>globalThis.fetch=original);
  await connect(getEnv(db),async(client)=>{
    const args={kb_id:kb,title:"sandbox-readback-test",content:"test-only",mode:"execute",confirm:true,operation_id:ids[3]};
    const failed=await client.callTool({name:"create_manual_knowledge",arguments:args});
    assert.equal(failed.isError,true);
    const audit=parsed(await client.callTool({name:"get_write_operation",arguments:{operation_id:ids[3]}}));
    assert.equal(audit.operation.state,"uncertain");
    assert.equal(audit.operation.result_id,doc);
    assert.ok(audit.audit_events.some(x=>x.code==="upstream_result_identified"));
    assert.ok(audit.audit_events.some(x=>x.code==="manual_reconciliation_required"));
    assert.equal((await client.callTool({name:"create_manual_knowledge",arguments:args})).isError,true);
    assert.equal(writes,1);
    assert.equal(readbacks,1);
  });
});
