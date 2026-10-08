import test from "node:test";
import assert from "node:assert/strict";
import { WriteLedger,payloadFingerprint } from "../src/write-ledger.ts";
import { createTestD1 } from "./support/sqlite-d1.mjs";

const kb="75dd92e0-7d69-4aec-acd7-133d16fac35e";
const knowledgeId="a9c354dc-166e-41a4-8d74-bd1da6b0040f";
const ids=[
 "6b6c1f58-f203-4e55-91da-99d47118af11",
 "6b6c1f58-f203-4e55-91da-99d47118af12",
 "6b6c1f58-f203-4e55-91da-99d47118af13",
];

test("D1 rejects replay of both operation UUID and identical content fingerprints",async(t)=>{
 const db=createTestD1();t.after(db.close);
 const l=new WriteLedger(db.d1);
 const hash=await payloadFingerprint("create",kb,undefined,"alpha","protected-not-in-log");
 const meta={operationId:ids[0],action:"create",kbId:kb,fingerprint:hash};
 await l.reserve(meta);
 await assert.rejects(l.reserve(meta),/already submitted/);
 await assert.rejects(l.reserve({...meta,operationId:ids[1]}),/already submitted/);
 await l.state(meta,"sent","upstream_dispatch");
 await l.state(meta,"success","upstream_confirmed",knowledgeId);
 const entry=await l.read(ids[0]);
 assert.equal(entry.state,"success");
 assert.equal(entry.result_id,knowledgeId);
 assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS c FROM weknora_write_ops").get().c,1);
 const events=db.sqlite.prepare("SELECT event,code FROM weknora_write_audit ORDER BY seq").all();
 assert.deepEqual(events.map(x=>x.event),["reserved","replay_denied","replay_denied","sent","success"]);
 assert.equal(JSON.stringify(db.sqlite.prepare("SELECT * FROM weknora_write_audit").all()).includes("protected-not-in-log"),false);
});

test("D1 same-document lock prevents parallel writers, and an uncertain write stays locked",async(t)=>{
 const db=createTestD1();t.after(db.close);
 const l=new WriteLedger(db.d1);
 const mk=async(i,content)=>({operationId:ids[i],action:"update",kbId:kb,knowledgeId,
  fingerprint:await payloadFingerprint("update",kb,knowledgeId,"title",content,"before")});
 const one=await mk(0,"first");const two=await mk(1,"second");
 await l.reserve(one);
 await l.acquireDocumentLock(one);
 await l.state(one,"sent","upstream_dispatch");
 await l.reserve(two);
 await assert.rejects(l.acquireDocumentLock(two),/already in progress/);
 assert.equal((await l.read(ids[1])).state,"rejected");
 await l.state(one,"uncertain","manual_reconciliation_required");
 await assert.rejects(l.acquireDocumentLock(two),/already in progress/);
 assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS c FROM weknora_write_locks").get().c,1);
});

test("Successful update releases lock and later revision can proceed",async(t)=>{
 const db=createTestD1();t.after(db.close);
 const l=new WriteLedger(db.d1);
 const base={action:"update",kbId:kb,knowledgeId};
 const m1={...base,operationId:ids[0],fingerprint:"ab".repeat(32)};
 const m2={...base,operationId:ids[1],fingerprint:"cd".repeat(32)};
 await l.reserve(m1);await l.acquireDocumentLock(m1);
 await l.state(m1,"success","upstream_confirmed",knowledgeId);
 await l.releaseDocumentLock(m1);
 await l.reserve(m2);await l.acquireDocumentLock(m2);
 assert.equal(db.sqlite.prepare("SELECT operation_id FROM weknora_write_locks").get().operation_id,ids[1]);
});

test("Different content with same operation UUID is rejected",async(t)=>{
 const db=createTestD1();t.after(db.close);
 const l=new WriteLedger(db.d1);
 const original={action:"create",kbId:kb,operationId:ids[0],fingerprint:"aa".repeat(32)};
 await l.reserve(original);
 await assert.rejects(l.reserve({...original,fingerprint:"bb".repeat(32)}),/already submitted/);
 assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS c FROM weknora_write_ops").get().c,1);
});
