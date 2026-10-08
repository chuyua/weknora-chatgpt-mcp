import test from "node:test";
import assert from "node:assert/strict";
import { decideScopes,READ_SCOPE } from "../src/oauth-scope-policy.ts";
import { WRITE_SCOPE,isWriteReady } from "../src/write-tools.ts";

test("OAuth treats mcp:write request without explicit consent as read-only",()=>{
  const requested=[READ_SCOPE,WRITE_SCOPE,"offline_access"];
  assert.deepEqual(decideScopes(requested,{writeReady:true,writeConsent:false}),[READ_SCOPE,"offline_access"]);
  assert.deepEqual(decideScopes(requested,{writeReady:false,writeConsent:true}),[READ_SCOPE,"offline_access"]);
  assert.deepEqual(decideScopes(requested,{writeReady:false,writeConsent:false}),[READ_SCOPE,"offline_access"]);
});
test("OAuth grants write only when requested, enabled, and consented",()=>{
  const readOnly=decideScopes([READ_SCOPE,"offline_access"],{writeReady:true,writeConsent:true});
  assert.ok(!readOnly.includes(WRITE_SCOPE));
  const elevated=decideScopes([WRITE_SCOPE,READ_SCOPE,"offline_access"],{writeReady:true,writeConsent:true});
  assert.deepEqual(elevated,[WRITE_SCOPE,READ_SCOPE,"offline_access"]);
});
test("OAuth denies unrecognized scopes and guarantees read",()=>{
  assert.deepEqual(decideScopes(["mcp:admin","mcp:delete"],{writeReady:true,writeConsent:true}),[READ_SCOPE]);
  assert.deepEqual(decideScopes([WRITE_SCOPE,READ_SCOPE,WRITE_SCOPE],{writeReady:true,writeConsent:true}),[WRITE_SCOPE,READ_SCOPE]);
  assert.deepEqual(decideScopes([], {writeReady:false,writeConsent:false}),[READ_SCOPE]);
});
test("no optional write tools when production lacks dedicated ledger/credential",()=>{
 const config={
   MCP_WRITE_ENABLED:"true",
   MCP_DRAFT_CONTRACT_VERIFIED:"true",
   OWNER_AUTH_SECRET:"owner-auth-independent-long-string",
   WEKNORA_API_KEY:"readonly-staging-test-string",
   WEKNORA_WRITE_API_KEY:"different-write-staging-test-string",
   WRITE_ALLOWED_KB_IDS:"75dd92e0-7d69-4aec-acd7-133d16fac35e"
 };
 assert.equal(isWriteReady(config),false);
 assert.equal(isWriteReady({...config,WRITE_LEDGER:{}}),true);
 assert.equal(isWriteReady({...config,WRITE_LEDGER:{},MCP_DRAFT_CONTRACT_VERIFIED:"false"}),false);
 assert.equal(isWriteReady({...config,WRITE_LEDGER:{},WEKNORA_WRITE_API_KEY:config.WEKNORA_API_KEY}),false);
});
