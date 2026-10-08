# WeKnora Official Hosted API — Phase B Draft/Publish Root Cause Evidence
Date: 2026-10-08; scoped to isolated sandbox only.

## Definitive observed behavior
Official managed cloud: https://weknora.weixin.qq.com/api/v1
Sandbox KB: 54753f2f-701a-4123-aaa6-d921108b0706
Existing sandbox test knowledge ID: a764e2cf-b0dc-4dab-9557-be2f509072d3
No original/legacy KB modified.

1. Earlier create and update with requested status='draft' both returned success, persisted metadata.status='publish', parse_status progressed through finalizing to completed, enable_status='enabled'.
2. Controlled update of SAME sandbox test record with deliberately invalid status='invalid_phaseb_validation_probe' and UNCHANGED Markdown body returned success, metadata.status='publish', version incremented 2→3. Official OSS service code internal/application/service/knowledge_create.go explicitly rejects values other than draft or publish. Therefore hosted runtime is behaviorally incompatible with current OSS handler/service contract.
3. Temporary non-secret runtime instrumentation inserted only in the dev adapter WeKnoraClient._request, exactly scoped to PUT /knowledge/manual/a764e2cf-b0dc-4dab-9557-be2f509072d3. A subsequent authorized dynamic MCP update of the same sandbox record with status='draft' and UNCHANGED Markdown body recorded **STATUS_CAPTURED=draft** immediately BEFORE Python requests.Session.request. Official hosted service returned HTTP-level success, data.metadata.status='publish', version 3→4. The earlier readback after invalid status showed the published status; the second tool's own response also showed publish.
4. Instrumentation was restored from a byte-identical backup (SHA256 2FB556801ACFABA9B8874A27EEB908176057FDE50BE301F1855C09F1FCB284A4), temp backup/log removed, dynamic development MCP server refreshed. No credentials, request headers, Markdown bodies or keyring contents were logged.
5. After testing, official cloud inventory remained exactly: sandbox 1 record, 大设郎设计学习库 1129, 微信转发 0, 网页笔记 0.

## Root cause, confidence and limitations
**High confidence:** The mismatch occurs AFTER the running Python development adapter built its outgoing JSON request, in the official hosted cloud API gateway/backend behavior. It is NOT caused by ChatGPT/Cloudflare MCP OAuth, NexusDock parameter schema, D1 ledger, Python code default or a dropped status argument at the adapter boundary.
Observed hosted behavior is compatible with two mechanisms: (A) hosted API silently ignores the status field and defaults to publish; (B) hosted API explicitly overrides status to publish. Only Tencent's running hosted backend version, request logs or contract owner can distinguish those mechanisms.
OSS current service validates ManualKnowledgePayload.Status and rejects invalid values; accepts draft without parsing and saves enable_status='disabled'/parse_status='draft'. The hosted service accepted invalid state, proving deployment/version/API contract divergence. Previous hosted /knowledge/folders route 404 while OSS has it adds circumstantial evidence of rollout skew, not conclusive version identification.
The official Go CLI raw unauthenticated request returned 401 MISSING_HEADERS for AppID/RequestID/Timestamp/Nonce/Signature; this is a separate credential/entrypoint mismatch and does NOT prove that a valid X-API-Key write requires all such signature fields. Valid dynamic MCP read/write calls to sandbox already succeeded with X-API-Key.
Sources:
- https://github.com/Tencent/WeKnora/blob/main/internal/application/service/knowledge_create.go
- https://github.com/Tencent/WeKnora/blob/main/internal/types/knowledge.go
- Development adapter C:\Users\李小龙\WeKnora\mcp-server\weknora_mcp_server.py: create_knowledge_from_text/update_knowledge_from_text and _request.

## Safe response / release gate
- DO NOT flip MCP_DRAFT_CONTRACT_VERIFIED or MCP_WRITE_ENABLED; do not provision production WRITE_LEDGER/WRITE_API_KEY or deploy write tools.
- The existing Phase B D1 idempotency, audit and read-after-write strict guard are correct fail-closed safety mitigations. They are NOT a way to prevent transient inadvertent publish before readback.
- Do NOT work around by publishing then disabling: it could create a temporary indexed/exposed document before later update.
- Request official hosted cloud deployed API version, support for manual status draft, and logs for controlled sandbox PUT route; or wait for official compatible endpoint release. A separate least-privileged KB-scoped test key is required for full future Cloudflare staging OAuth/write E2E.
- Production read-only nine-tool MCP remains unchanged. The local development adapter was restored cleanly.
