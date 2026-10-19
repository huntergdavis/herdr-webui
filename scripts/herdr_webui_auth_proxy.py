#!/usr/bin/env python3
"""Cookie-authenticated TCP/WebSocket proxy in front of the Herdr WebUI.

The WebUI itself is bound to loopback and trusts localhost (its default
`localhost_no_auth` mode). This proxy is the auth boundary for a LAN
browser: it only forwards a connection after the VP desk session cookie
(`vp_session`) validates against the desk's SQLite session table.

Why a raw TCP proxy instead of an HTTP reverse proxy:

* the WebUI uses HTTP, WebSockets, and long-lived terminal streams;
* after the first authenticated HTTP request, forwarding raw bytes keeps
  every protocol (including WebSocket upgrades) working without a second
  WebSocket client dependency;
* assets and API paths stay unchanged, so no HTML/JS rewriting is needed.

The tradeoff is that a keep-alive HTTP connection is authenticated only at
its first request. That is acceptable here because the browser only reaches
this listener after the owner has a valid desk session, and the upstream is
loopback-only.

Environment:

  HERDR_WEBUI_PROXY_BIND     listen address       (default 0.0.0.0:8789)
  HERDR_WEBUI_PROXY_BACKEND  upstream address     (default 127.0.0.1:8788)
  VP_AUTH_DB                 desk SQLite DB       (default
                             /home/hunter/workspace/vp-of-agenty/data/messages.sqlite3)
  HERDR_WEBUI_PROXY_LOGIN    desk login URL shown on 401
                             (default http://127.0.0.1:8787/)
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import sqlite3
import sys
import time
from urllib.parse import urlsplit

BIND = os.environ.get("HERDR_WEBUI_PROXY_BIND", "0.0.0.0:8789")
BACKEND = os.environ.get("HERDR_WEBUI_PROXY_BACKEND", "127.0.0.1:8788")
AUTH_DB = os.environ.get(
    "VP_AUTH_DB",
    "/home/hunter/workspace/vp-of-agenty/data/messages.sqlite3",
)
LOGIN_URL = os.environ.get("HERDR_WEBUI_PROXY_LOGIN", "http://127.0.0.1:8787/")
MAX_HEADER_BYTES = 64 * 1024
HEADER_TIMEOUT_S = 15.0
CONNECT_TIMEOUT_S = 10.0
COOKIE_NAME = "vp_session"


def _host_port(value: str) -> tuple[str, int]:
    if value.startswith("["):
        host, _, rest = value[1:].partition("]")
        return host, int(rest.lstrip(":"))
    host, sep, port = value.rpartition(":")
    if not sep:
        return value, 0
    return host, int(port)


def _session_valid(cookie: str) -> bool:
    if not cookie:
        return False
    token_hash = hashlib.sha256(cookie.encode()).hexdigest()
    try:
        # Read-only URI mode: the proxy must never create/lock the desk DB.
        connection = sqlite3.connect(f"file:{AUTH_DB}?mode=ro", uri=True, timeout=2)
    except sqlite3.Error:
        return False
    try:
        row = connection.execute(
            "SELECT expires_at FROM sessions WHERE token_hash=?", (token_hash,)
        ).fetchone()
        return row is not None and float(row[0]) > time.time()
    except sqlite3.Error:
        return False
    finally:
        connection.close()


def _cookie_from_headers(headers: dict[str, str]) -> str:
    raw = headers.get("cookie", "")
    for part in raw.split(";"):
        name, _, value = part.strip().partition("=")
        if name == COOKIE_NAME:
            return value
    return ""



def _deny() -> bytes:
    body = (
        "<!doctype html><meta charset='utf-8'><title>Sign in required</title>"
        "<body style='font-family:system-ui;background:#0b1116;color:#dbe7ee;"
        "padding:2rem'><h2>Sign in required</h2>"
        "<p>The Herdr web UI is available after signing in to the VP desk.</p>"
        f"<p><a style='color:#83c6ed' href='{LOGIN_URL}'>Open the VP desk</a></p>"
    )
    payload = body.encode()
    return (
        b"HTTP/1.1 401 Unauthorized\r\n"
        b"Content-Type: text/html; charset=utf-8\r\n"
        b"Cache-Control: no-store\r\n"
        b"Connection: close\r\n"
        + f"Content-Length: {len(payload)}\r\n\r\n".encode()
        + payload
    )


async def _pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError, OSError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


def _rewrite_request_for_close(
    request_line: str, headers: list[tuple[str, str]], websocket: bool
) -> bytes:
    """Rebuild the request head, forcing Connection: close for plain HTTP.

    A fresh upstream connection per request lets the proxy inspect every
    response head and remove the WebUI's `X-Frame-Options: DENY`, which
    would otherwise prevent the desk iframe from loading the app.
    WebSocket upgrades keep their original headers and are spliced raw.
    """
    if websocket:
        out = [request_line]
        out.extend(f"{name}: {value}" for name, value in headers)
        return ("\r\n".join(out) + "\r\n\r\n").encode("iso-8859-1")
    out = [request_line]
    for name, value in headers:
        if name.lower() in {"connection", "keep-alive", "proxy-connection"}:
            continue
        out.append(f"{name}: {value}")
    out.append("Connection: close")
    return ("\r\n".join(out) + "\r\n\r\n").encode("iso-8859-1")


def _strip_frame_deny(header_block: bytes) -> bytes:
    """Remove X-Frame-Options from a response head, preserving other bytes."""
    text = header_block.decode("iso-8859-1")
    lines = text.split("\r\n")
    kept = [line for line in lines if not line.lower().startswith("x-frame-options:")]
    return "\r\n".join(kept).encode("iso-8859-1")


async def _forward_http(
    upstream_reader: asyncio.StreamReader,
    upstream_writer: asyncio.StreamWriter,
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    content_length: int,
) -> None:
    """Forward one request/response pair with the frame header stripped."""
    async def request_body() -> None:
        remaining = content_length
        while remaining > 0:
            chunk = await reader.read(min(65536, remaining))
            if not chunk:
                break
            upstream_writer.write(chunk)
            await upstream_writer.drain()
            remaining -= len(chunk)

    async def response() -> None:
        try:
            head = await upstream_reader.readuntil(b"\r\n\r\n")
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError):
            return
        writer.write(_strip_frame_deny(head))
        await writer.drain()
        await _pump(upstream_reader, writer)

    await asyncio.gather(request_body(), response())


async def _handle(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    peer = writer.get_extra_info("peername")
    try:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HEADER_TIMEOUT_S)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError):
            return
        if len(head) > MAX_HEADER_BYTES:
            return
        text = head.decode("iso-8859-1", "replace")
        lines = text.split("\r\n")
        if not lines or not lines[0]:
            return
        request_line = lines[0]
        raw_headers: list[tuple[str, str]] = []
        headers: dict[str, str] = {}
        for line in lines[1:]:
            name, sep, value = line.partition(":")
            if not sep:
                continue
            name = name.strip()
            value = value.strip()
            raw_headers.append((name, value))
            headers[name.lower()] = value

        websocket = headers.get("upgrade", "").lower() == "websocket"
        try:
            content_length = int(headers.get("content-length", "0") or "0")
        except ValueError:
            content_length = 0
        cookie = _cookie_from_headers(headers)
        if not _session_valid(cookie):
            writer.write(_deny())
            await writer.drain()
            return

        backend_host, backend_port = _host_port(BACKEND)
        upstream_reader, upstream_writer = await asyncio.wait_for(
            asyncio.open_connection(backend_host, backend_port), CONNECT_TIMEOUT_S
        )
        upstream_writer.write(_rewrite_request_for_close(request_line, raw_headers, websocket))
        await upstream_writer.drain()
        if websocket:
            await asyncio.gather(
                _pump(reader, upstream_writer),
                _pump(upstream_reader, writer),
            )
        else:
            await _forward_http(
                upstream_reader, upstream_writer, reader, writer, content_length
            )
    except Exception as error:  # noqa: BLE001 - one bad client must not kill the proxy
        print(f"herdr-webui-auth-proxy: {peer}: {error}", file=sys.stderr)
    finally:
        try:
            writer.close()
        except OSError:
            pass


async def main() -> None:
    listen_host, listen_port = _host_port(BIND)
    server = await asyncio.start_server(
        _handle, listen_host, listen_port, limit=MAX_HEADER_BYTES * 2
    )
    addresses = ", ".join(str(sock.getsockname()) for sock in server.sockets or [])
    print(f"herdr-webui-auth-proxy: listening on {addresses} -> {BACKEND}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
