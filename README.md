# WeKnora ChatGPT MCP

A small, read-only MCP adapter that lets ChatGPT access a WeKnora knowledge base over Streamable HTTP.

## Architecture

ChatGPT → HTTPS MCP endpoint → WeKnora REST API

The service exposes four tools:

- `weknora_status`
- `list_knowledge_bases`
- `search_knowledge`
- `get_knowledge`

## Security

No API key is stored in this repository.

Configure these environment variables in Render:

- `WEKNORA_BASE_URL` — default: `https://weknora.weixin.qq.com/api/v1`
- `WEKNORA_API_KEY` — required secret
- `MCP_ACCESS_TOKEN` — required secret protecting the public MCP endpoint

The MCP endpoint refuses requests if `MCP_ACCESS_TOKEN` is missing.

## Render

Build command:

```bash
pip install -r requirements.txt
```

Start command:

```bash
uvicorn server:app --host 0.0.0.0 --port $PORT
```

Health endpoint:

```
GET /healthz
```

MCP endpoint:

```
POST /mcp
```

## Notes

This adapter is intentionally read-only. It does not create, edit, or delete WeKnora knowledge.
