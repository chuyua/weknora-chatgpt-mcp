// Durable single-writer coordination for the ChatGPT → Cloudflare MCP path.
// WeKnora has no verified atomic If-Match support: this does NOT serialize
// changes made directly in WeKnora or through unrelated integrations.
export type WriteAction = "create" | "update";
export type WriteState = "reserved" | "sent" | "success" | "uncertain" | "rejected";
export type WriteMeta = {
  operationId:string; action:WriteAction; kbId:string;
  knowledgeId?:string; fingerprint:string;
};
export type WriteRecord = {
  operation_id:string; action:WriteAction; kb_id:string;
  knowledge_id:string|null; state:WriteState;
  result_id:string|null; created_at:string;updated_at:string;
};

async function digest(value:string):Promise<string> {
  const raw=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(raw),x=>x.toString(16).padStart(2,"0")).join("");
}
export async function payloadFingerprint(action:WriteAction, kbId:string,
  knowledgeId:string|undefined,title:string,content:string,expectedRevision?:string):Promise<string> {
  return digest(JSON.stringify([action,kbId.toLowerCase(),knowledgeId||null,title,content,expectedRevision||null]));
}

export class WriteLedger {
  private readonly db:D1Database;
  constructor(db:D1Database){this.db=db;}
  async audit(m:WriteMeta,event:string,code="ok"):Promise<void> {
    const info=await this.db.prepare(
      "INSERT INTO weknora_write_audit (operation_id,action,kb_id,knowledge_id,event,code) VALUES (?,?,?,?,?,?)")
      .bind(m.operationId,m.action,m.kbId,m.knowledgeId??null,event,code).run();
    if(!info.success) throw new Error("Audit write failed; aborting operation");
  }
  async reserve(m:WriteMeta):Promise<void> {
    const created=await this.db.prepare(
      "INSERT OR IGNORE INTO weknora_write_ops (operation_id,fingerprint,action,kb_id,knowledge_id,state) VALUES (?,?,?,?,?,'reserved')")
      .bind(m.operationId,m.fingerprint,m.action,m.kbId,m.knowledgeId??null).run();
    if(created.meta.changes!==1) {
      await this.audit(m,"replay_denied","duplicate_operation_or_payload");
      throw new Error("This write request or identical payload was already submitted");
    }
    // If audit fails, reservation remains and cannot silently retry.
    await this.audit(m,"reserved","ok");
  }
  async acquireDocumentLock(m:WriteMeta):Promise<void> {
    if(!m.knowledgeId) return;
    const claim=await this.db.prepare(
      "INSERT OR IGNORE INTO weknora_write_locks(knowledge_id,operation_id) VALUES(?,?)")
      .bind(m.knowledgeId,m.operationId).run();
    if(claim.meta.changes!==1) {
      await this.state(m,"rejected","same_document_write_in_progress");
      throw new Error("A change to this knowledge record is already in progress");
    }
    await this.audit(m,"document_lock_acquired","ok");
  }
  async state(m:WriteMeta,newState:WriteState,code:string,resultId?:string):Promise<void> {
    const update=await this.db.prepare(
      "UPDATE weknora_write_ops SET state=?, result_id=COALESCE(?,result_id),updated_at=datetime('now') WHERE operation_id=?")
      .bind(newState,resultId??null,m.operationId).run();
    if(update.meta.changes!==1) throw new Error("Write operation journal unavailable");
    await this.audit(m,newState,code);
  }
  async releaseDocumentLock(m:WriteMeta):Promise<void> {
    if(!m.knowledgeId) return;
    const x=await this.db.prepare(
      "DELETE FROM weknora_write_locks WHERE knowledge_id=? AND operation_id=?")
      .bind(m.knowledgeId,m.operationId).run();
    if(!x.success) throw new Error("Document lock release failed");
  }
  async read(operationId:string):Promise<WriteRecord|null> {
    return this.db.prepare("SELECT operation_id,action,kb_id,knowledge_id,state,result_id,created_at,updated_at FROM weknora_write_ops WHERE operation_id=?")
      .bind(operationId).first<WriteRecord>();
  }
  async events(operationId:string):Promise<unknown[]> {
    const records=await this.db.prepare(
      "SELECT seq,event,code,created_at FROM weknora_write_audit WHERE operation_id=? ORDER BY seq LIMIT 100")
      .bind(operationId).all();
    if(!records.success) throw new Error("Write audit unavailable");
    return records.results;
  }
}
