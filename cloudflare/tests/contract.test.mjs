import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/index.ts',import.meta.url),'utf8') + '\n' + readFileSync(new URL('../src/knowledge-tools.ts',import.meta.url),'utf8');

test('expected nine readonly tools registered',()=>{
 for(const name of ['weknora_status','list_knowledge_bases','search_knowledge','get_knowledge','get_knowledge_base','list_knowledge','list_chunks','list_knowledge_folders','get_chunk_by_id']){
  assert.match(src,new RegExp('"' + name + '"'));
 }
});
test('write or destructive MCP tools are not exposed',()=>{
 assert.doesNotMatch(src,/server\.tool\(\s*"(create_knowledge|delete_knowledge|update_knowledge|upload_file|delete_knowledge_base)"/);
});
test('pagination inputs are bounded and validated',()=>{
 assert.equal((src.match(/page_size: z\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)/g)||[]).length,2);
 assert.equal((src.match(/\.uuid\(\)/g)||[]).length>=3,true);
});
test('chunk route matches official API',()=> {
 assert.match(src,/\`chunks\/\$\{encodeURIComponent\(knowledge_id\)\}\?\$\{params\}\`/);
});
test('authorization scope is read-only',()=> {
 assert.match(src,/const READ_SCOPE = "mcp:read"/);
 assert.doesNotMatch(src,/mcp:write|mcp:admin/);
});
test('credential is not emitted in MCP status',()=> {
 const status=src.slice(src.indexOf('"weknora_status"'),src.indexOf('"list_knowledge_bases"'));
 assert.doesNotMatch(status,/api_key:\s*env\.WEKNORA_API_KEY/);
});
