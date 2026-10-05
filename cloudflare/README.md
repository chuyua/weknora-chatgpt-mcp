# WeKnora Cloudflare MCP

Cloudflare Workers implementation of the WeKnora ChatGPT MCP adapter.

Architecture:

ChatGPT -> Cloudflare OAuth Provider -> stateless Streamable HTTP MCP -> WeKnora REST API.

The Worker exposes four read-only tools:

- weknora_status
- list_knowledge_bases
- search_knowledge
- get_knowledge

WEKNORA_API_KEY is a Cloudflare Worker Secret and is never committed to Git.

The Render implementation remains available as a rollback target until the Cloudflare deployment passes end-to-end verification.
