import test from "node:test";
import assert from "node:assert/strict";
import { requirePersistedDraft } from "../src/manual-draft-guard.ts";

const id="a764e2cf-b0dc-4dab-9557-be2f509072d3";
const kb="54753f2f-701a-4123-aaa6-d921108b0706";
const valid=()=>({
 id, knowledge_base_id:kb, type:"manual",
 enable_status:"disabled",parse_status:"draft",
 metadata:{status:"draft",format:"markdown",version:1,content:"example"},
});

test("persisted draft must remain disabled, unindexed, correctly scoped and Markdown",()=>{
 assert.doesNotThrow(()=>requirePersistedDraft(valid(),id,kb));
 const published={...valid(),enable_status:"enabled",parse_status:"finalizing",metadata:{...valid().metadata,status:"publish"}};
 assert.throws(()=>requirePersistedDraft(published,id,kb),/unpublished Markdown draft/);
 const toggled={...valid(),enable_status:"enabled"};
 assert.throws(()=>requirePersistedDraft(toggled,id,kb),/indexed or enabled/);
 const pending={...valid(),parse_status:"pending"};
 assert.throws(()=>requirePersistedDraft(pending,id,kb),/indexed or enabled/);
});

test("refuse wrong KB or document, unknown format and invalid metadata",()=>{
 assert.throws(()=>requirePersistedDraft({...valid(),knowledge_base_id:"other"},id,kb),/identity mismatch/);
 assert.throws(()=>requirePersistedDraft({...valid(),id:"other"},id,kb),/identity mismatch/);
 assert.throws(()=>requirePersistedDraft({...valid(),type:"file"},id,kb),/identity mismatch/);
 assert.throws(()=>requirePersistedDraft({...valid(),metadata:{status:"draft",format:"text"}},id,kb),/unpublished Markdown draft/);
 assert.throws(()=>requirePersistedDraft({...valid(),metadata:"{broken"},id,kb),/metadata is not valid/);
 assert.throws(()=>requirePersistedDraft(null,id,kb),/cannot be verified/);
});
test("allow stringified valid metadata from API only with disabled/unindexed state",()=>{
 const v=valid();
 assert.doesNotThrow(()=>requirePersistedDraft({...v,metadata:JSON.stringify(v.metadata)},id,kb));
});
