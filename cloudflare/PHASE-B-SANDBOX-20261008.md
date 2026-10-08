# Phase B cloud sandbox / integration checkpoint — 2026-10-08

## Authorized scope and isolation
User explicitly approved creating a NEW WeKnora knowledge base only, with NO modifications to existing knowledge bases.
Architecture: ChatGPT WeKnora App -> Cloudflare MCP -> official WeKnora cloud. NexusDock is used ONLY for one-time development provisioning and supervision, not the production runtime.
New KB id: 54753f2f-701a-4123-aaa6-d921108b0706
Name: PHASE-B-MCP-安全写入沙盒-20261008
Initial knowledge count: 0. A single manual test document now exists.
Test document id: a764e2cf-b0dc-4dab-9557-be2f509072d3
A one-off development adapter invoked create_knowledge_from_text(status='draft') and update_knowledge_from_text(status='draft') ONLY on the NEW sandbox KB; both returned success but persisted metadata.status='publish', version 1 then 2. Cloud GET confirmed content marker UPDATE-TEST-V2, title V2; parse_status was processing/finalizing. **This is an incompatible/unsafe draft contract, regardless of whether the dev adapter or hosted backend caused it. DO NOT ENABLE WRITES.**
Baseline original KB list after tests: 大设郎设计学习库 1129 records; 微信转发 0; 网页笔记 0; none written/modified. New sandbox 1 record.

## Code response to confirmed mismatch
- Introduced MCP_DRAFT_CONTRACT_VERIFIED=true as additional mandatory write gate; do not set it until a separate test credential proves genuine persisted draft status on hosted cloud.
- After any future authorized write, the MCP re-reads the actual knowledge entry and verifies KB ID, type manual, and metadata.status='draft' before marking success; failures become uncertain and block retries.
- Added regression testing wrong-state 'publish'; 32/32 local suite tests passed, npm audit 0, Cloudflare dry run passed.
- Staging config WRITE_ALLOWED_KB_IDS set EXCLUSIVELY to sandbox id 54753f2f-701a-4123-aaa6-d921108b0706 and MCP_WRITE_ENABLED='false'.
- Production remains untouched: nine read-only tools, no release/merge of Phase B.

## Remaining before writes can be enabled
1. Obtain independent scoped WeKnora cloud API key with retrieve + ingest, knowledge_base_ids restricted to ONLY the sandbox (tenant_id 366899); avoid asking user to paste key in chat. Current WeKnora ChatGPT connector only exposes nine read tools and NexusDock development adapter has no API-key creation action.
2. Test RAW official cloud POST/PUT with that scoped key, and inspect persisted metadata; investigate dev adapter ignoring status or managed backend changing draft. Only after correct draft is proved can MCP_DRAFT_CONTRACT_VERIFIED be set.
3. Validate ChatGPT OAuth mcp:write authorization and denial, D1 idempotency, and audit records using staging. Production retains no write keys.
4. Test reconciliation for uncertain writes and cross-channel edit protection (not guaranteed without upstream atomic CAS).
5. Do not grant new key manage_kbs, write access to original KBs, or delete scopes; keep new sandbox for all tests.
