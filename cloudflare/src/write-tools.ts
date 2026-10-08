import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiEnv } from "./knowledge-tools.ts";
import { WriteLedger, payloadFingerprint, type WriteMeta } from "./write-ledger.ts";
import { requirePersistedDraft } from "./manual-draft-guard.ts";

export const WRITE_SCOPE = "mcp:write";
// Phase B writes are a sandbox-only experiment. Lifting this limit requires
// a separately reviewed production release, not an environment-variable flip.
export const PHASE_B_SANDBOX_KB_ID = "54753f2f-701a-4123-aaa6-d921108b0706";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_KBS=20;
export function permittedWriteKbs(env:ApiEnv):Set<string> {
  const values=(env.WRITE_ALLOWED_KB_IDS??"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  if(!values.length||values.length>MAX_KBS||values.some(x=>!UUID.test(x))) return new Set();
  return new Set(values);
}
export function isWriteReady(env:ApiEnv):boolean {
  const permitted=permittedWriteKbs(env);
  return env.MCP_WRITE_ENABLED==="true"
    && env.MCP_DRAFT_CONTRACT_VERIFIED==="true"
    && typeof env.OWNER_AUTH_SECRET==="string" && env.OWNER_AUTH_SECRET.length>=20
    && typeof env.WEKNORA_WRITE_API_KEY==="string" && env.WEKNORA_WRITE_API_KEY.length>15
    && env.WEKNORA_WRITE_API_KEY!==env.WEKNORA_API_KEY
    && !!env.WRITE_LEDGER
    && permitted.size===1
    && permitted.has(PHASE_B_SANDBOX_KB_ID);
}
type ApiCall=(env:ApiEnv,method:"GET"|"POST"|"PUT",path:string,body?:unknown)=>Promise<unknown>;
function unwrap(v:unknown):unknown {
  return v&&typeof v==="object"&&"data" in v ? (v as {data:unknown}).data:v;
}
function jsonResult(value:unknown){
  return {content:[{type:"text" as const,text:JSON.stringify(value)}]};
}
function knowledgeId(v:unknown):string|undefined {
  if(v&&typeof v==="object"&&"id" in v && typeof v.id==="string"&&UUID.test(v.id)) return v.id;
}
export function registerWriteTools(server:McpServer,env:ApiEnv,call:ApiCall):void {
  if(!isWriteReady(env)) return;
  const allowed=permittedWriteKbs(env);
  const ledger=new WriteLedger(env.WRITE_LEDGER!);
  const writeEnv={...env,WEKNORA_API_KEY:env.WEKNORA_WRITE_API_KEY!};
  const requireAllowed=(kb:string)=>{
    if(!allowed.has(kb.toLowerCase())) throw new Error("Knowledge base is not authorized for writes");
  };
  const finalize=async(m:WriteMeta,action:()=>Promise<unknown>,unlock:boolean)=>{
    let dispatched=false;
    let draftContractViolation=false;
    try{
      await ledger.state(m,"sent","upstream_dispatch");
      dispatched=true;
      const result=unwrap(await action());
      const id=knowledgeId(result);
      if(!id) throw new Error("Upstream response has no valid knowledge ID");
      // Persist the upstream ID BEFORE verifying the stored state, so an
      // unexpectedly published record can be located during reconciliation.
      await ledger.state(m,"sent","upstream_result_identified",id);
      // Do not trust request status=draft alone. The managed cloud has
      // been observed returning publish for draft requests. Verify by
      // reading the actual persisted record before reporting success.
      const persisted=unwrap(await call(env,"GET",`knowledge/${encodeURIComponent(id)}`));
      try {
        requirePersistedDraft(persisted,id,m.kbId);
      } catch {
        draftContractViolation=true;
        throw new Error("Persisted draft safety invariant failed");
      }
      await ledger.state(m,"success","upstream_confirmed",id);
      if(unlock) await ledger.releaseDocumentLock(m);
      return jsonResult({performed:true,operation_id:m.operationId,state:"success",knowledge_id:id});
    }catch(error){
      if(dispatched){
        // Network or response error might follow a committed upstream write:
        // never retry automatically and retain document lock for reconciliation.
        try{await ledger.state(m,"uncertain",draftContractViolation ? "draft_contract_violation" : "manual_reconciliation_required");}catch{}
      }else{
        try{await ledger.state(m,"rejected","not_dispatched");}catch{}
        if(unlock) await ledger.releaseDocumentLock(m);
      }
      throw new Error("Write could not be confirmed. Do not retry with a new operation ID; inspect the audit record");
    }
  };
  server.tool("create_manual_knowledge",
    "Create a draft Markdown record. Preview by default. For execute pass a stable operation_id UUID and confirm=true; no automatic retry.",
    {
      kb_id:z.string().uuid(),
      title:z.string().trim().min(1).max(200),
      content:z.string().trim().min(1).max(100000),
      mode:z.enum(["preview","execute"]).default("preview"),
      confirm:z.boolean().default(false),
      operation_id:z.string().uuid().optional(),
    },
    async({kb_id,title,content,mode,confirm,operation_id})=>{
      requireAllowed(kb_id);
      if(mode==="preview") return jsonResult({operation:"create",kb_id,title,content_length:content.length,status:"draft",performed:false,requires_confirmation:true});
      if(!confirm||!operation_id) throw new Error("Explicit confirmation and operation_id required");
      const m:WriteMeta={operationId:operation_id,action:"create",kbId:kb_id,
        fingerprint:await payloadFingerprint("create",kb_id,undefined,title,content)};
      await ledger.reserve(m);
      return finalize(m,()=>call(writeEnv,"POST",`knowledge-bases/${encodeURIComponent(kb_id)}/knowledge/manual`,{title,content,status:"draft"}),false);
    });
  server.tool("update_manual_knowledge",
    "Edit an existing manual Markdown draft with a timestamp check and durable document lock. Does not protect concurrent updates outside this MCP.",
    {
      kb_id:z.string().uuid(),knowledge_id:z.string().uuid(),
      title:z.string().trim().min(1).max(200),
      content:z.string().trim().min(1).max(100000),
      expected_updated_at:z.string().min(10).max(80),
      mode:z.enum(["preview","execute"]).default("preview"),
      confirm:z.boolean().default(false),
      operation_id:z.string().uuid().optional(),
    },
    async({kb_id,knowledge_id,title,content,expected_updated_at,mode,confirm,operation_id})=>{
      requireAllowed(kb_id);
      if(mode==="execute"&&(!confirm||!operation_id)) throw new Error("Explicit confirmation and operation_id required");
      const m:WriteMeta={
        operationId:operation_id||crypto.randomUUID(),action:"update",kbId:kb_id,knowledgeId:knowledge_id,
        fingerprint:await payloadFingerprint("update",kb_id,knowledge_id,title,content,expected_updated_at),
      };
      if(mode==="execute"){
        await ledger.reserve(m);
        await ledger.acquireDocumentLock(m);
      }
      let latest:Record<string,unknown>;
      try{
        latest=unwrap(await call(env,"GET",`knowledge/${encodeURIComponent(knowledge_id)}`)) as Record<string,unknown>;
        if(!latest||latest.knowledge_base_id!==kb_id||latest.type!=="manual")
          throw new Error("Knowledge record is not the requested manual entry in the authorized KB");
        requirePersistedDraft(latest,knowledge_id,kb_id);
        if(latest.updated_at!==expected_updated_at)
          throw new Error("Document changed since preview; review again before updating");
      }catch(error){
        if(mode==="execute"){
          await ledger.state(m,"rejected","preflight_failed");
          await ledger.releaseDocumentLock(m);
        }
        throw error;
      }
      if(mode==="preview") return jsonResult({
        operation:"update",kb_id,knowledge_id,title,content_length:content.length,
        performed:false,requires_confirmation:true,expected_updated_at,
      });
      return finalize(m,()=>call(writeEnv,"PUT",`knowledge/manual/${encodeURIComponent(knowledge_id)}`,{title,content,status:"draft"}),true);
    });
  server.tool("get_write_operation",
    "Read one operation state for incident investigation; no knowledge content or credentials.",
    {operation_id:z.string().uuid()},
    async({operation_id})=>jsonResult({
      operation:await ledger.read(operation_id),
      audit_events:await ledger.events(operation_id),
    }));
  server.tool("inspect_write_reconciliation",
    "Read-only investigation of one prior sandbox write. Uses its recorded upstream ID; reveals state metadata only, never content or credentials. Does not retry, republish, or unlock anything.",
    {operation_id:z.string().uuid()},
    async({operation_id})=>{
      const operation=await ledger.read(operation_id);
      if(!operation) return jsonResult({found:false,operation_id});
      if(operation.kb_id.toLowerCase()!==PHASE_B_SANDBOX_KB_ID)
        throw new Error("Only Phase B sandbox write records may be inspected");
      const audit_events=await ledger.events(operation_id);
      const lock_owner=operation.knowledge_id ? await ledger.lockOwner(operation.knowledge_id) : null;
      if(!operation.result_id){
        return jsonResult({
          found:true,operation_id,state:operation.state,
          remote_check:"no_upstream_id",requires_manual_reconciliation:true,
          lock_held:lock_owner===operation_id,audit_events,
        });
      }
      let remote:Record<string,unknown>;
      try{
        remote=unwrap(await call(env,"GET",`knowledge/${encodeURIComponent(operation.result_id)}`)) as Record<string,unknown>;
      }catch{
        return jsonResult({
          found:true,operation_id,upstream_knowledge_id:operation.result_id,
          state:operation.state,remote_check:"readback_unavailable",
          requires_manual_reconciliation:true,
          lock_held:lock_owner===operation_id,audit_events,
        });
      }
      let draft_verified=false;
      try{requirePersistedDraft(remote,operation.result_id,PHASE_B_SANDBOX_KB_ID);draft_verified=true;}catch{}
      // Never include metadata.content, title, bearer credentials or response bodies.
      return jsonResult({
        found:true,operation_id,upstream_knowledge_id:operation.result_id,
        state:operation.state,remote_check:draft_verified?"unpublished_draft_confirmed":"draft_contract_not_verified",
        remote_parse_status:typeof remote?.parse_status==="string"?remote.parse_status:null,
        remote_enable_status:typeof remote?.enable_status==="string"?remote.enable_status:null,
        requires_manual_reconciliation:operation.state!=="success"||!draft_verified,
        lock_held:lock_owner===operation_id,audit_events,
      });
    });
}
