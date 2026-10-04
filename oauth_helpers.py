from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import os
import re
import time
import urllib.parse
from typing import Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from starlette.routing import Mount, Route
from starlette.types import ASGIApp, Receive, Scope, Send


DEFAULT_BASE = "https://weknora-chatgpt-mcp.onrender.com"
SCOPE_NAME = "weknora.read"
_STABLE_CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect"
_CALLBACK_RE = re.compile(r"^https://chatgpt\.com/connector/oauth/[A-Za-z0-9_-]+$")


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def public_base() -> str:
    return _env("PUBLIC_BASE_URL", DEFAULT_BASE).rstrip("/")


def resource_url() -> str:
    return f"{public_base()}/mcp"


def _secret() -> bytes:
    value = _env("MCP_ACCESS_TOKEN")
    if not value:
        raise RuntimeError("MCP_ACCESS_TOKEN is not configured")
    return value.encode("utf-8")


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _sign(payload: dict[str, Any]) -> str:
    body = _b64e(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    sig = _b64e(hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).digest())
    return f"wkm1.{body}.{sig}"


def _verify(token: str, expected_type: str) -> dict[str, Any] | None:
    try:
        prefix, body, sig = token.split(".", 2)
        if prefix != "wkm1":
            return None
        expected = _b64e(hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(_b64d(body))
        if payload.get("typ") != expected_type:
            return None
        if int(payload.get("exp", 0)) <= int(time.time()):
            return None
        return payload
    except Exception:
        return None


def _valid_redirect(uri: str) -> bool:
    return uri == _STABLE_CALLBACK or bool(_CALLBACK_RE.fullmatch(uri))


def _redirect(uri: str, **params: str) -> str:
    parsed = urllib.parse.urlsplit(uri)
    query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    query.update(params)
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query), parsed.fragment)
    )


def _oauth_error(error: str, description: str, status: int = 400) -> JSONResponse:
    return JSONResponse(
        {"error": error, "error_description": description},
        status_code=status,
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


async def protected_resource(_: Request) -> JSONResponse:
    return JSONResponse(
        {
            "resource": resource_url(),
            "authorization_servers": [public_base()],
            "scopes_supported": [SCOPE_NAME],
            "bearer_methods_supported": ["header"],
            "resource_documentation": "https://github.com/chuyuai-cpu/weknora-chatgpt-mcp",
        }
    )


async def authorization_server_metadata(_: Request) -> JSONResponse:
    base = public_base()
    return JSONResponse(
        {
            "issuer": base,
            "authorization_endpoint": f"{base}/authorize",
            "token_endpoint": f"{base}/token",
            "registration_endpoint": f"{base}/register",
            "revocation_endpoint": f"{base}/revoke",
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "scopes_supported": [SCOPE_NAME],
            "authorization_response_iss_parameter_supported": True,
        }
    )


async def register(request: Request) -> JSONResponse:
    try:
        data = await request.json()
    except Exception:
        return _oauth_error("invalid_client_metadata", "Expected a JSON registration document.")

    redirect_uris = data.get("redirect_uris")
    if not isinstance(redirect_uris, list) or not redirect_uris:
        return _oauth_error("invalid_redirect_uri", "redirect_uris is required.")

    clean_redirects: list[str] = []
    for item in redirect_uris:
        if not isinstance(item, str) or not _valid_redirect(item):
            return _oauth_error("invalid_redirect_uri", "Only ChatGPT connector callback URLs are allowed.")
        clean_redirects.append(item)

    token_auth = data.get("token_endpoint_auth_method", "none")
    if token_auth != "none":
        return _oauth_error("invalid_client_metadata", "This server supports public PKCE clients only.")

    now = int(time.time())
    client_id = _sign(
        {
            "typ": "client",
            "redirect_uris": clean_redirects,
            "iat": now,
            "exp": now + 365 * 24 * 3600,
        }
    )
    return JSONResponse(
        {
            "client_id": client_id,
            "client_id_issued_at": now,
            "client_id_expires_at": now + 365 * 24 * 3600,
            "redirect_uris": clean_redirects,
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        },
        status_code=201,
        headers={"Cache-Control": "no-store"},
    )


def _validate_authorize_query(request: Request) -> tuple[dict[str, Any] | None, Response | None]:
    q = request.query_params
    if q.get("response_type") != "code":
        return None, _oauth_error("unsupported_response_type", "Only response_type=code is supported.")

    client_id = q.get("client_id", "")
    client = _verify(client_id, "client")
    if not client:
        return None, _oauth_error("invalid_request", "Unknown or expired client_id.")

    redirect_uri = q.get("redirect_uri", "")
    if redirect_uri not in client.get("redirect_uris", []) or not _valid_redirect(redirect_uri):
        return None, _oauth_error("invalid_request", "redirect_uri is not registered.")

    if q.get("code_challenge_method") != "S256" or not q.get("code_challenge"):
        return None, _oauth_error("invalid_request", "PKCE S256 is required.")

    resource = q.get("resource")
    if resource != resource_url():
        return None, _oauth_error("invalid_target", "resource must identify this MCP endpoint.")

    scopes = [s for s in q.get("scope", SCOPE_NAME).split(" ") if s]
    if any(s != SCOPE_NAME for s in scopes):
        return None, _oauth_error("invalid_scope", "Unsupported scope.")

    now = int(time.time())
    flow = {
        "typ": "flow",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "state": q.get("state", ""),
        "code_challenge": q["code_challenge"],
        "scope": scopes or [SCOPE_NAME],
        "resource": resource,
        "iat": now,
        "exp": now + 600,
    }
    return flow, None


async def authorize(request: Request) -> Response:
    if request.method == "GET":
        flow, error = _validate_authorize_query(request)
        if error:
            return error
        assert flow is not None
        flow_token = _sign(flow)
        page = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>连接 WeKnora</title>
<style>
body{{font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;line-height:1.55}}
.card{{border:1px solid #ddd;border-radius:16px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,.06)}}
input{{width:100%;box-sizing:border-box;padding:12px;margin:10px 0 16px;border:1px solid #bbb;border-radius:8px}}
button{{width:100%;padding:12px;border:0;border-radius:8px;background:#111;color:#fff;font-weight:600;cursor:pointer}}
.small{{font-size:13px;color:#666}}
</style>
</head>
<body><div class="card">
<h2>连接 WeKnora 云知识库</h2>
<p>请输入你当前有效的 WeKnora API Key 完成一次所有权验证。</p>
<p class="small">Key 只会通过 HTTPS 提交到你自己的 Render 服务，并与 Render 中已保存的 Secret 做常量时间比较；不会返回给 ChatGPT，也不会写入 GitHub。</p>
<form method="post" action="/authorize">
<input type="hidden" name="flow" value="{html.escape(flow_token, quote=True)}">
<label>WeKnora API Key</label>
<input type="password" name="api_key" autocomplete="current-password" required>
<button type="submit">授权 ChatGPT 只读访问</button>
</form>
</div></body></html>"""
        return HTMLResponse(page)

    form = await request.form()
    flow_token = form.get("flow")
    supplied_key = form.get("api_key")
    if not isinstance(flow_token, str) or not isinstance(supplied_key, str):
        return _oauth_error("invalid_request", "Missing authorization form fields.")

    flow = _verify(flow_token, "flow")
    if not flow:
        return _oauth_error("invalid_request", "Authorization session expired. Start the connection again.")

    expected_key = _env("WEKNORA_API_KEY")
    if not expected_key or not hmac.compare_digest(supplied_key, expected_key):
        return HTMLResponse(
            "<h3>授权失败</h3><p>WeKnora API Key 不正确。请返回 ChatGPT 后重新连接。</p>",
            status_code=401,
        )

    now = int(time.time())
    code = _sign(
        {
            "typ": "code",
            "client_id": flow["client_id"],
            "redirect_uri": flow["redirect_uri"],
            "code_challenge": flow["code_challenge"],
            "scope": flow["scope"],
            "resource": flow["resource"],
            "sub": "weknora-owner",
            "iat": now,
            "exp": now + 120,
        }
    )
    params = {"code": code, "state": str(flow.get("state", "")), "iss": public_base()}
    return RedirectResponse(_redirect(flow["redirect_uri"], **params), status_code=302)


def _pkce_s256(verifier: str) -> str:
    return _b64e(hashlib.sha256(verifier.encode("ascii")).digest())


def _mint_access(client_id: str, scopes: list[str], resource: str, subject: str) -> tuple[str, str]:
    now = int(time.time())
    access = _sign(
        {
            "typ": "access",
            "client_id": client_id,
            "scope": scopes,
            "resource": resource,
            "sub": subject,
            "iat": now,
            "exp": now + 3600,
        }
    )
    refresh = _sign(
        {
            "typ": "refresh",
            "client_id": client_id,
            "scope": scopes,
            "resource": resource,
            "sub": subject,
            "iat": now,
            "exp": now + 30 * 24 * 3600,
        }
    )
    return access, refresh


async def token(request: Request) -> JSONResponse:
    form = await request.form()
    grant_type = form.get("grant_type")
    client_id = form.get("client_id")
    if not isinstance(client_id, str) or not _verify(client_id, "client"):
        return _oauth_error("invalid_client", "Unknown or expired public client.", 401)

    if grant_type == "authorization_code":
        code_value = form.get("code")
        redirect_uri = form.get("redirect_uri")
        verifier = form.get("code_verifier")
        resource = form.get("resource")
        if not all(isinstance(x, str) for x in (code_value, redirect_uri, verifier, resource)):
            return _oauth_error("invalid_request", "Missing authorization-code grant fields.")

        code = _verify(str(code_value), "code")
        if not code:
            return _oauth_error("invalid_grant", "Authorization code is invalid or expired.")
        if code.get("client_id") != client_id or code.get("redirect_uri") != redirect_uri:
            return _oauth_error("invalid_grant", "Client or redirect URI mismatch.")
        if code.get("resource") != resource_url() or resource != resource_url():
            return _oauth_error("invalid_target", "Resource mismatch.")
        if not hmac.compare_digest(_pkce_s256(str(verifier)), str(code.get("code_challenge", ""))):
            return _oauth_error("invalid_grant", "PKCE verification failed.")

        scopes = list(code.get("scope") or [SCOPE_NAME])
        access, refresh = _mint_access(client_id, scopes, resource_url(), str(code.get("sub", "weknora-owner")))
        return JSONResponse(
            {
                "access_token": access,
                "token_type": "Bearer",
                "expires_in": 3600,
                "refresh_token": refresh,
                "scope": " ".join(scopes),
            },
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        )

    if grant_type == "refresh_token":
        refresh_value = form.get("refresh_token")
        resource = form.get("resource", resource_url())
        if not isinstance(refresh_value, str):
            return _oauth_error("invalid_request", "refresh_token is required.")
        refresh = _verify(refresh_value, "refresh")
        if not refresh or refresh.get("client_id") != client_id:
            return _oauth_error("invalid_grant", "Refresh token is invalid or expired.")
        if refresh.get("resource") != resource_url() or resource != resource_url():
            return _oauth_error("invalid_target", "Resource mismatch.")

        scopes = list(refresh.get("scope") or [SCOPE_NAME])
        access, new_refresh = _mint_access(client_id, scopes, resource_url(), str(refresh.get("sub", "weknora-owner")))
        return JSONResponse(
            {
                "access_token": access,
                "token_type": "Bearer",
                "expires_in": 3600,
                "refresh_token": new_refresh,
                "scope": " ".join(scopes),
            },
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        )

    return _oauth_error("unsupported_grant_type", "Use authorization_code or refresh_token.")


async def revoke(_: Request) -> Response:
    # Tokens are signed and stateless. Rotating MCP_ACCESS_TOKEN invalidates all
    # current access, refresh, code, flow, and dynamic-client tokens at once.
    return Response(status_code=200)


async def healthz(_: Request) -> PlainTextResponse:
    return PlainTextResponse("ok")


class OAuthGate:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http" or scope.get("path", "").rstrip("/") != "/mcp":
            await self.app(scope, receive, send)
            return

        auth = ""
        for key, value in scope.get("headers", []):
            if key.lower() == b"authorization":
                auth = value.decode("latin-1")
                break

        supplied = auth[7:] if auth.startswith("Bearer ") else ""
        payload = _verify(supplied, "access") if supplied else None
        legacy = _env("MCP_ACCESS_TOKEN")
        valid_legacy = bool(supplied and legacy and hmac.compare_digest(supplied, legacy))

        if payload:
            valid = (
                payload.get("resource") == resource_url()
                and SCOPE_NAME in (payload.get("scope") or [])
            )
        else:
            valid = valid_legacy

        if valid:
            await self.app(scope, receive, send)
            return

        challenge = (
            f'Bearer resource_metadata="{public_base()}/.well-known/oauth-protected-resource", '
            f'scope="{SCOPE_NAME}"'
        )
        response = JSONResponse(
            {"error": "unauthorized"},
            status_code=401,
            headers={"WWW-Authenticate": challenge, "Cache-Control": "no-store"},
        )
        await response(scope, receive, send)


def build_protected_app(mcp_app: ASGIApp) -> ASGIApp:
    outer = Starlette(
        routes=[
            Route("/.well-known/oauth-protected-resource", protected_resource, methods=["GET"]),
            Route("/.well-known/oauth-authorization-server", authorization_server_metadata, methods=["GET"]),
            Route("/register", register, methods=["POST"]),
            Route("/authorize", authorize, methods=["GET", "POST"]),
            Route("/token", token, methods=["POST"]),
            Route("/revoke", revoke, methods=["POST"]),
            Route("/healthz", healthz, methods=["GET"]),
            Mount("/", app=mcp_app),
        ]
    )
    return OAuthGate(outer)
