from __future__ import annotations

import hmac
import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send


DEFAULT_BASE_URL = "https://weknora.weixin.qq.com/api/v1"
SERVICE_NAME = "WeKnora ChatGPT MCP"


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _weknora_config() -> tuple[str, str]:
    base_url = _env("WEKNORA_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    api_key = _env("WEKNORA_API_KEY")
    return base_url, api_key


def _request_json(
    method: str,
    endpoint: str,
    *,
    body: dict[str, Any] | None = None,
    query: dict[str, Any] | None = None,
    timeout: int = 60,
) -> Any:
    base_url, api_key = _weknora_config()
    if not api_key:
        raise RuntimeError("WEKNORA_API_KEY is not configured.")

    url = f"{base_url}/{endpoint.lstrip('/')}"
    if query:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query, doseq=True)

    headers = {
        "Accept": "application/json",
        "X-API-Key": api_key,
        "User-Agent": "weknora-chatgpt-mcp/1.0",
    }

    payload: bytes | None = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(url, data=payload, headers=headers, method=method)

    try:
        with urllib.request.urlopen(
            req,
            timeout=timeout,
            context=ssl.create_default_context(),
        ) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(raw) if raw else {}
        except Exception:
            detail = {"message": raw[:1000]}
        raise RuntimeError(f"WeKnora HTTP {exc.code}: {detail}") from exc
    except Exception as exc:
        raise RuntimeError(
            f"WeKnora connection failed: {type(exc).__name__}: {exc}"
        ) from exc


def _unwrap_data(payload: Any) -> Any:
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


mcp = MCPServer(SERVICE_NAME)


@mcp.tool()
def weknora_status() -> dict[str, Any]:
    """Check WeKnora connectivity without exposing credentials."""
    base_url, api_key = _weknora_config()
    result: dict[str, Any] = {
        "base_url": base_url,
        "api_key_configured": bool(api_key),
        "reachable": False,
    }

    if not api_key:
        return result

    try:
        payload = _request_json("GET", "knowledge-bases", timeout=20)
        data = _unwrap_data(payload)
        if isinstance(data, dict):
            data = data.get("items", data.get("list", []))
        result["reachable"] = True
        result["knowledge_base_count"] = len(data) if isinstance(data, list) else None
    except Exception as exc:
        result["error"] = str(exc)

    return result


@mcp.tool()
def list_knowledge_bases() -> dict[str, Any]:
    """List knowledge bases visible to the configured WeKnora credential."""
    payload = _request_json("GET", "knowledge-bases", timeout=30)
    data = _unwrap_data(payload)

    if isinstance(data, dict):
        data = data.get("items", data.get("list", data))

    if not isinstance(data, list):
        return {"knowledge_bases": data}

    fields = (
        "id",
        "name",
        "description",
        "knowledge_count",
        "chunk_count",
        "is_processing",
    )
    cleaned: list[dict[str, Any]] = []

    for item in data:
        if isinstance(item, dict):
            cleaned.append({key: item.get(key) for key in fields if key in item})

    return {"knowledge_bases": cleaned}


@mcp.tool()
def search_knowledge(
    query: str,
    knowledge_base_ids: list[str] | None = None,
    limit: int = 10,
) -> dict[str, Any]:
    """Search WeKnora, optionally within selected knowledge-base IDs."""
    query = query.strip()
    if not query:
        raise ValueError("query is required")

    limit = max(1, min(int(limit), 30))
    body: dict[str, Any] = {
        "query": query,
        "match_count": limit,
    }

    if knowledge_base_ids:
        body["knowledge_base_ids"] = knowledge_base_ids

    payload = _request_json(
        "POST",
        "knowledge-search",
        body=body,
        query={"resource_urls": "public"},
        timeout=90,
    )
    data = _unwrap_data(payload)

    if isinstance(data, dict) and "items" in data:
        data = data["items"]
    if not isinstance(data, list):
        data = [data]

    fields = (
        "id",
        "content",
        "score",
        "knowledge_id",
        "knowledge_title",
        "knowledge_filename",
        "chunk_index",
        "chunk_type",
        "match_type",
        "metadata",
        "image_info",
    )

    results: list[dict[str, Any]] = []
    for item in data[:limit]:
        if isinstance(item, dict):
            results.append({key: item.get(key) for key in fields if key in item})

    return {
        "query": query,
        "count": len(results),
        "results": results,
    }


@mcp.tool()
def get_knowledge(knowledge_id: str) -> Any:
    """Read one WeKnora knowledge item by ID."""
    knowledge_id = knowledge_id.strip()
    if not knowledge_id:
        raise ValueError("knowledge_id is required")

    payload = _request_json(
        "GET",
        f"knowledge/{urllib.parse.quote(knowledge_id, safe='')}",
        query={"resource_urls": "public"},
        timeout=60,
    )
    return _unwrap_data(payload)


async def healthz(_: Request) -> PlainTextResponse:
    return PlainTextResponse("ok")


class StaticBearerAuth:
    """Small ASGI wrapper protecting only the MCP endpoint with a static bearer secret."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path != "/mcp":
            await self.app(scope, receive, send)
            return

        expected = _env("MCP_ACCESS_TOKEN")
        if not expected:
            response = JSONResponse(
                {"error": "MCP_ACCESS_TOKEN is not configured"},
                status_code=503,
            )
            await response(scope, receive, send)
            return

        auth_header = ""
        for key, value in scope.get("headers", []):
            if key.lower() == b"authorization":
                auth_header = value.decode("latin-1")
                break

        prefix = "Bearer "
        supplied = auth_header[len(prefix):] if auth_header.startswith(prefix) else ""

        if not supplied or not hmac.compare_digest(supplied, expected):
            response = JSONResponse(
                {"error": "unauthorized"},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)


_mcp_app = mcp.streamable_http_app(
    streamable_http_path="/mcp",
    json_response=True,
    stateless_http=True,
    host="0.0.0.0",
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
    ),
    custom_starlette_routes=[
        Route("/healthz", endpoint=healthz, methods=["GET"]),
    ],
)

app = StaticBearerAuth(_mcp_app)
