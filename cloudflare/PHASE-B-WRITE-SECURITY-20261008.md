# Phase B Write Safety — Development and Release Gate
Date: 2026-10-08. Repo: chuyuai-cpu/weknora-chatgpt-mcp, Draft PR #5 (NO MERGE).
Architecture: ChatGPT WeKnora App → Cloudflare OAuth MCP → Official WeKnora cloud. NexusDock supervises only.

## Verified upstream contract, from Tencent/WeKnora source
- POST /api/v1/knowledge-bases/{id}/knowledge/manual
- PUT /api/v1/knowledge/manual/{id}
- JSON payload types.ManualKnowledgePayload: title, content, status (draft / publish), tag_ids, channel, process_config.
- File upload uses POST /api/v1/knowledge-bases/{id}/knowledge/file, multipart/form-data, not yet implemented in Phase B.
- Official service requires editor/admin write permission; has no verified conditional update / ETag atomic CAS endpoint.

Sources:
- https://github.com/Tencent/WeKnora/blob/main/internal/handler/knowledge.go
- https://github.com/Tencent/WeKnora/blob/main/internal/types/knowledge.go
- https://github.com/Tencent/WeKnora/blob/main/internal/application/service/knowledge_create.go

## Access gates and operations
- Production remains read-only, 9 tool endpoints. No MCP_WRITE_ENABLED, WRITE_LEDGER or separate upstream key are configured in production.
- Writes register only when OWNER_AUTH_SECRET is strong, MCP_WRITE_ENABLED=true, independent WEKNORA_WRITE_API_KEY, WRITE_LEDGER D1 binding, WRITE_ALLOWED_KB_IDS nonempty; OAuth mcp:write scope explicitly approved.
- User must preview, then execute with confirm=true and stable operation_id (UUID).
- Create and update only Markdown drafts; updates validate manual record, same KB, current draft status, and updated_at before dispatch.
- No delete, publish, file upload or bulk write tools.

## Durable D1 idempotency & audit
- Migration: migrations/0001_phase_b_write_ledger.sql.
- weknora_write_ops stores UUID and unique SHA-256 fingerprint (NOT content), state: reserved/sent/success/uncertain/rejected.
- weknora_write_locks serializes updates by knowledge ID across THIS MCP deployment; D1 SQLite uniqueness is authoritative.
- weknora_write_audit records operation ID, action, KB ID, knowledge ID, state/event, code and timestamp; NO content, API keys or bearer tokens.
- get_write_operation retrieves state + up to 100 audit events for an operation ID (requires write authorization).
- Replays are blocked, including same content with new UUID. Upstream ambiguity marked uncertain, no automatic replay; update lock remains until manual reconciliation.
- A D1 outage denies writes. Do not clear locks or replay in bulk without inspecting upstream and audit.

## Staging
- Cloudflare Pages project: weknora-mcp-chuyuai-staging, independent OAUTH_KV.
- Dedicated staging D1: weknora-phaseb-staging-write-ledger, migrations executed.
- Staging build/test deployed with WRITE_LEDGER bound but MCP_WRITE_ENABLED unset; actual write endpoints remain DISABLED.
- Staging health and OAuth metadata HTTP 200; anonymous MCP HTTP 401.
- No upstream write key configured, so NO REAL WRITE transaction has been attempted or claimed as verified.

## Blockers before enabling writes
1. Dedicated test KB and least-privileged WeKnora upstream write credential.
2. Authorized OAuth mcp:write E2E grant + deny tests with real ChatGPT client.
3. Actual managed-cloud POST/PUT schema and response test on disposable KB only.
4. External concurrent editors: current timestamp and D1 lock cover only this MCP; official conditional update support not verified. A stronger cross-channel concurrency guarantee is impossible without upstream compare-and-set or exclusive write policy.
5. Operational reconciliation procedure for uncertain writes (manual read-back and controlled unlocking).
6. File uploads have not been implemented or approved.

Production change policy: DO NOT MERGE DRAFT PR #5 or deploy experimental writes without all gates.
