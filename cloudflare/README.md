# WeKnora Cloudflare MCP

Cloudflare Pages/Workers implementation of the WeKnora MCP adapter for ChatGPT and Claude.

Production endpoints:

- https://weknora.xzdq.eu.org/mcp (custom domain for new connections)
- https://weknora-mcp-chuyuai.pages.dev/mcp (existing connections)

Each hostname publishes its own matching OAuth issuer and protected resource. Existing
pages.dev grants retain their original audience. Start authorization from the client's
connector settings; opening `/authorize` directly lacks the required OAuth parameters.

The public homepage and authorization page link to `/icon.png`, `/favicon.ico`, and
`/site.webmanifest`. MCP initialization also advertises the icon URL. Some clients use
an external favicon cache, so their displayed icon can update later than the website.

Architecture:

ChatGPT / Claude -> Cloudflare OAuth Provider -> stateless Streamable HTTP MCP -> WeKnora REST API.

The production MCP exposes nine read-only tools:

- weknora_status
- list_knowledge_bases
- search_knowledge
- get_knowledge
- get_knowledge_base
- list_knowledge
- list_chunks
- get_chunk_by_id
- list_knowledge_folders

Why Pages is the primary endpoint:

- The current network path corrupts or resets `*.workers.dev` traffic.
- `*.pages.dev` is reachable and uses the same Cloudflare Workers runtime for Pages Functions.
- The Pages deployment uses Advanced Mode: Wrangler bundles the Worker into `pages-dist/_worker.js` before deployment.
- The build copies `public/` to `pages-dist/`. `_routes.json` serves the homepage and icon files as public static assets while OAuth and MCP requests use the Worker.

Security:

- `WEKNORA_API_KEY` is a Cloudflare Pages Secret and is never committed to Git.
- `OWNER_AUTH_SECRET` is the separate authorization-page password, stored as a Cloudflare Secret.
- OAuth grants only `mcp:read` plus optional `offline_access`.
- Each MCP request creates a fresh `McpServer` instance, as required by MCP SDK 1.26+ cross-client isolation protections.

Deployment:

```sh
npm ci
npm run verify:phase-a
npm run deploy:pages
```

`verify:phase-a` runs TypeScript, tests, the dependency audit, the Pages dry-run build,
and local Worker runtime checks for both hostnames. The runtime checks use temporary
in-memory KV and random fixture credentials; they do not contact production WeKnora.

The original Render implementation remains unchanged at repository root as a rollback target until the Cloudflare deployment passes end-to-end verification.
