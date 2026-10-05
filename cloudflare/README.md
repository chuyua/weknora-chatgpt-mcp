# WeKnora Cloudflare MCP

Cloudflare Pages/Workers implementation of the WeKnora ChatGPT MCP adapter.

Production endpoint:

- https://weknora-mcp-chuyuai.pages.dev/mcp

Architecture:

ChatGPT -> Cloudflare OAuth Provider -> stateless Streamable HTTP MCP -> WeKnora REST API.

The MCP exposes four read-only tools:

- weknora_status
- list_knowledge_bases
- search_knowledge
- get_knowledge

Why Pages is the primary endpoint:

- The current network path corrupts or resets `*.workers.dev` traffic.
- `*.pages.dev` is reachable and uses the same Cloudflare Workers runtime for Pages Functions.
- The Pages deployment uses Advanced Mode: Wrangler bundles the Worker into `pages-dist/_worker.js` before deployment.

Security:

- `WEKNORA_API_KEY` is a Cloudflare Pages Secret and is never committed to Git.
- OAuth grants only `mcp:read` plus optional `offline_access`.
- Each MCP request creates a fresh `McpServer` instance, as required by MCP SDK 1.26+ cross-client isolation protections.

Deployment:

```powershell
npm install
npm run deploy:pages
```

The original Render implementation remains unchanged at repository root as a rollback target until the Cloudflare deployment passes end-to-end verification.
