# WeKnora Cloud MCP · Phase A release checklist (2026-10-07)

## Single-App topology
ChatGPT WeKnora App → `https://weknora-mcp-chuyuai.pages.dev/mcp` (Cloudflare OAuth MCP) → WeKnora managed `https://weknora.weixin.qq.com/api/v1`.
NexusDock is used for remote development supervision only, and is **not** in production runtime.

## Changes in isolated worktree
- 9 read-only tools: weknora_status, list_knowledge_bases, get_knowledge_base, list_knowledge, get_knowledge, list_chunks, get_chunk_by_id, list_knowledge_folders, search_knowledge.
- Explicitly **not** exposed: KB-level hybrid_search. Live WeKnora managed cloud returned HTTP 404 on that route, despite public API docs. No write/admin tools.
- OAuth failure counter: 5 per IP-hash within TTL 15 min stored in Cloudflare KV; best-effort only because KV is eventually consistent. Add Cloudflare WAF edge rate limiting before production.
- Response body error suppression; 20s abort timeout; limit upstream body to 3 MB; HTTPS-only upstream base; validated UUID and bounded page sizes/query.
- Anonymous /healthz reports liveness only. Test upstream connectivity via OAuth-protected weknora_status.
- OAuth credential form has restrictive CSP, no-referrer/no-store/nosniff headers.
- No production secrets in git or test fixtures.

## Verification
- Local command: `npm run verify:phase-a` — npm audit, tests, TypeScript and Cloudflare dry-run bundle; **never deploys**.
- GitHub Actions: project root .github/workflows/weknora-phase-a.yml, expects cloudflare/ dir as in repository.
- Verified through existing authenticated WeKnora local connector, not via the public Cloudflare MCP OAuth path: get KB, list paginated items, get one item, list chunks all succeeded. Dataset: 3 knowledge bases, 大设郎设计学习库 1129 knowledge entries.
- KB hybrid-search through managed cloud returned 404 and was not shipped.
- In-memory MCP client and stateless HTTP transport tests use a mock upstream. Public Cloudflare OAuth access not yet tested end-to-end with ChatGPT App.
- Explicit residual gaps: OAuth callback integration / refresh / expiry / rejected scopes; true tenant ACL and cross-KB credential isolation in real managed cloud; per-client WAF rules, max concurrency, support for streaming SSE; production route unmodified.

## Deployment gate and rollback
1. Create GitHub draft PR, require CI green. Review dependency pin / lockfile and secrets detection, ensure no diff to production key.
2. Provision separate staging Pages project with separate OAuth KV and dedicated least-privilege retrieve-only API Key; never reuse production KV or key in staging.
3. Run OAuth PKCE, token exchange/refresh, Bearer denial tests and all 9 tools from ChatGPT's custom App registration UI; inspect returned metadata without revealing secret.
4. Apply WAF edge rate limiting on /authorize POST; verify x-forwarded header trust. Remove any exposed older key by rotating Cloudflare Secret.
5. Before production publish, export Cloudflare deploy artifact and project environment metadata for rollback; back up current release reference.
6. Deploy to production only if staging green, WAF is live, OAuth end-to-end passes, and rollback is proven. Roll back immediately on auth failures or incorrect KB access.

## No-go conditions
Do not deploy without official Cloudflare MFA/authorization flow, or while cross-tenant access and secure refresh aren't proven. Do not expose write/admin tools in Phase A.
