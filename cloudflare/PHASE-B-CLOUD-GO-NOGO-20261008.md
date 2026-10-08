# Phase B official managed-cloud go/no-go and reconciliation — 2026-10-08

## Architecture and change boundary
Production chain remains ChatGPT WeKnora App → Cloudflare OAuth MCP → Tencent WeKnora managed cloud. NexusDock is **development supervisor only**.
No changes, uploads, updates, deletes or schema migrations to legacy knowledge bases.
Actual cloud read-only inventory (post inspection):
- 大设郎设计学习库: 75dd92e0-7d69-4aec-acd7-133d16fac35e, 1129 items.
- 微信转发: 2276692e-802c-468e-b9ed-840c7aff8c1c, 0 items.
- 网页笔记: e8af9e34-a4a4-4e8f-95fc-24f8b8d8fb5a, 0 items.
- Isolated Phase B test KB: 54753f2f-701a-4123-aaa6-d921108b0706, 1 item.
- Isolated test document: a764e2cf-b0dc-4dab-9557-be2f509072d3.
The manual sandbox document was created/updated previously using a development adapter with status='draft' but persisted status='publish', parse_status='completed', enable_status='enabled'. This remains an unsafe upstream contract mismatch.

## Source and evidence
- Tencent/WeKnora website-docs/04-api/02-api-knowledge.md: POST knowledge-bases/:id/knowledge/manual, PUT knowledge/manual/:id, JSON status draft/publish.
- Tencent/WeKnora internal/types/knowledge.go: ManualKnowledgePayload.Status and ManualKnowledgePayload.IsDraft implemented.
- NexusDock dynamic dev adapter C:\Users\李小龙\WeKnora\mcp-server\weknora_mcp_server.py forwards status in JSON to both endpoints.
- Official hosted service is NOT proven to run the same build as public Tencent/WeKnora. The public docs also describe scoped workspace keys (retrieve + ingest capability, KB UUID whitelist).
- No *separate* scoped write credential or direct authenticated raw HTTP E2E is available in the current ChatGPT MCP App. Never read/print/copy tokens from OS credential stores or encrypted Cloudflare secrets to bypass this gate.

## Safety invariants before ANY staging write flag
1. Only sandbox KB may be in WRITE_ALLOWED_KB_IDS. Keep original 3 KB IDs entirely absent.
2. MCP_WRITE_ENABLED remains false, MCP_DRAFT_CONTRACT_VERIFIED remains unset/false, WEKNORA_WRITE_API_KEY absent until read-after-write on *official hosted cloud* confirms status='draft', parse_status='draft', enable_status='disabled'.
3. A separate KB-scoped key, created through authorized official management UI/API, with only retrieve+ingest, must be stored in Cloudflare staging encrypted secret (never in repository/chat).
4. D1 ledger stores only UUID, action, KB, upstream ID, content fingerprint, state, timestamps and audit events, never raw Markdown, credentials or bearer tokens.
5. No replay after unknown upstream commit: state='uncertain'; retain update lock, upstream ID, and audit. Only a human-reviewed reconciliation may decide how to handle published test docs.
6. Cross-client atomic compare-and-set is not available/verified. The D1 lock serializes **only MCP writes**, not WeKnora GUI or other integrations.
7. No production deployment or write activation is part of the code-only PR.

## New read-only reconciliation tool
When future sandbox write tools are authorized, inspect_write_reconciliation(operation_id) reads only the D1 record/audit and, if known, the actual upstream document by ID. It never copies title/body/metadata.content, never retries, publishes or unlocks. Returns:
- no_upstream_id: no safe direct lookup available.
- readback_unavailable: upstream GET errored; remain uncertain.
- draft_contract_not_verified: stored state failed strict draft/unindexed invariant.
- unpublished_draft_confirmed: remote state complies; historical operation state still requires manual review if marked uncertain.

## Actual verification
Local 36/36 regression tests passed for strict OAuth, D1 uniqueness/locks/audit, unexpected publish, readback failure, and safe reconciliation. Typecheck, dependency audit (0 vulnerabilities) and Cloudflare dry-run build pass.
Official cloud inventory read-only verified 4 KBs, legacy counts unchanged.
Go/no-go status: **NO-GO for enabling writes**, until a dedicated scoped credential and verified true draft persistence on hosted cloud. Do NOT interpret merged code as production release.
