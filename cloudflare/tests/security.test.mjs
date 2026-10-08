import test from "node:test";
import assert from "node:assert/strict";
import { weknoraRequest } from "../src/knowledge-tools.ts";
import { failureKey, authIsBlocked, recordAuthFailure, clearAuthFailures } from "../src/oauth-guards.ts";

test("upstream failures never reflect private response bodies", async (t) => {
  const old = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"sk-SECRET_PRIVATE_DATA"}',{status:401});
  t.after(() => globalThis.fetch=old);
  await assert.rejects(
    weknoraRequest({WEKNORA_BASE_URL:"https://weknora.weixin.qq.com/api/v1",WEKNORA_API_KEY:"sk-SECRET_PRIVATE_DATA"},"GET","knowledge-bases"),
    error => error.message === "WeKnora upstream HTTP 401" && !error.message.includes("SECRET_PRIVATE"),
  );
});
test("blocks non-HTTPS upstream, enforces response size, and caps request duration", async (t) => {
  const old=globalThis.fetch;
  let observed;
  globalThis.fetch=async (_url,options) => {
    observed=options;
    return new Response("not worth parsing",{headers:{"Content-Length":"4000000"}});
  };
  t.after(()=>globalThis.fetch=old);
  const env={WEKNORA_BASE_URL:"https://weknora.weixin.qq.com/api/v1",WEKNORA_API_KEY:"test"};
  await assert.rejects(weknoraRequest({...env,WEKNORA_BASE_URL:"http://127.0.0.1:8080"},"GET","knowledge-bases"),/HTTPS/);
  await assert.rejects(weknoraRequest(env,"GET","knowledge-bases"),/size limit/);
  assert.equal(typeof observed.signal?.aborted,"boolean");
});
test("HTTP 200 success=false does not masquerade as successful data", async (t) => {
  const old=globalThis.fetch;
  globalThis.fetch=async () => new Response('{"success":false,"message":"private error"}',{status:200});
  t.after(()=>globalThis.fetch=old);
  await assert.rejects(weknoraRequest({WEKNORA_BASE_URL:"https://weknora.weixin.qq.com/api/v1",WEKNORA_API_KEY:"test"},"GET","knowledge-bases"),/rejected request/);
});
test("OAuth failed attempts are bounded per pseudonymous IP",async()=>{
 const values=new Map();
 const kv={
   get:async key=>values.get(key)??null,
   put:async (key,value)=>{ values.set(key,value); },
   delete:async key=>{values.delete(key);}
 };
 const a=await failureKey(new Request("https://weknora.example/authorize",{headers:{"CF-Connecting-IP":"203.0.113.1"}}));
 const b=await failureKey(new Request("https://weknora.example/authorize",{headers:{"CF-Connecting-IP":"203.0.113.2"}}));
 assert.notEqual(a,b);
 assert.equal(a.includes("203.0.113"),false);
 for(let i=0;i<5;i++)await recordAuthFailure(kv,a);
 assert.equal(await authIsBlocked(kv,a),true);
 assert.equal(await authIsBlocked(kv,b),false);
 await clearAuthFailures(kv,a);
 assert.equal(await authIsBlocked(kv,a),false);
});
