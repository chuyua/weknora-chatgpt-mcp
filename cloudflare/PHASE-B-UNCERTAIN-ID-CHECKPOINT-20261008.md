# Phase B — Hosted Draft Contract & Reconciliation Checkpoint (2026-10-08)

## Architecture and constraints
ChatGPT WeKnora App → Cloudflare OAuth MCP → WeKnora official managed cloud. NexusDock is development supervisor only.
Original KBs strictly preserved: 大设郎设计学习库 (1129), 微信转发 (0), 网页笔记 (0). ALL mutation tests scoped to isolated sandbox KB 54753f2f-701a-4123-aaa6-d921108b0706. No production deployment or write activation.
Official hosted sandbox document a764e2cf-b0dc-4dab-9557-be2f509072d3 unexpectedly persisted metadata.status=publish despite requests status=draft through dev adapter on create and update.

## Source-level findings
Tencent/WeKnora internal/types/knowledge.go defines ManualKnowledgePayload.Title/Content/Status fields and draft/publish constants. NexusDock development adapter weknora_mcp_server.py forwards status into JSON for both POST and PUT. Actual hosted WeKnora cloud's deployed behavior is not proven equivalent to upstream repository and raw official request using an independent scoped credential has NOT been completed. No claim that the server itself is definitely at fault.
The remote development node did not expose a dedicated WeKnora API key file or env var to direct raw requests; protected adapter credentials must not be scraped, logged or shared.

## This incremental hardening
The MCP persists a confirmed upstream response knowledge ID into the D1 operational ledger immediately after upstream POST/PUT acknowledges it and BEFORE readback. If the persisted record violates the draft-only safety invariant, mark the operation uncertain with audited code draft_contract_violation. If readback fails, uncertain has audit code manual_reconciliation_required but still retains result_id. No automatic retry or release of update lock after ambiguous result.
Added regression assertions for unexpected published results and readback network failure retaining operation.result_id and audit events.
Local npm run verify:phase-a: 36/36 tests pass; TypeScript passed; npm audit reports 0 vulnerabilities; Cloudflare build dry-run succeeded.

## Release gates
- Do NOT enable MCP_WRITE_ENABLED or MCP_DRAFT_CONTRACT_VERIFIED, do NOT configure production WRITE_LEDGER or WEKNORA_WRITE_API_KEY. Production continues 9 read-only tools.
- Existing sandbox KB alone in staging allowlist; staging MCP_WRITE_ENABLED=false.
- Real managed-cloud draft contract must be verified by a separately scoped test credential via direct API before activating writes.
- Cross-client atomic compare-and-swap still not verified, so never claim universal concurrency protection.
- Reconcile uncertain operations manually using stored operation ID/result ID, native cloud readback, and audit event log; never replay automatically.

## Deliverable
Code-only safe change via GitHub PR, CI verification before merge; no runtime chain changes.
