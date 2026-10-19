"""Tests for the Herdr WebUI auth proxy (redirect + session lookup).

Run with:
  python3 -m unittest scripts.herdr_webui_auth_proxy_test -v

The proxy is a standalone stdlib script, so this test deliberately does not
start the async listener: it pins the two security-critical pure paths,
host-aware login redirects and the read-only session-token lookup.
"""

from __future__ import annotations

import hashlib
import importlib.util
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

SCRIPT = Path(__file__).with_name("herdr_webui_auth_proxy.py")
SPEC = importlib.util.spec_from_file_location("herdr_webui_auth_proxy", SCRIPT)
proxy = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(proxy)


class LoginRedirectTests(unittest.TestCase):
    def location(self, host: str, target: str = "/session/default") -> tuple[str, dict]:
        value = proxy._login_redirect_location(host, f"GET {target} HTTP/1.1")
        parsed = urlsplit(value)
        return value, parse_qs(parsed.query)

    def test_follows_request_host_and_fixed_desk_port(self):
        for host in ("cell:8789", "192.168.0.209:8789", "localhost:8789"):
            value, query = self.location(host)
            expected_host = host.rsplit(":", 1)[0]
            self.assertEqual(f"http://{expected_host}:8787/", value.split("?next=")[0])
            self.assertEqual([f"http://{host}/session/default"], query["next"])

    def test_ipv4_literal_is_preserved(self):
        value, query = self.location("192.168.0.209:8789", "/api/panes?x=1")
        self.assertTrue(value.startswith("http://192.168.0.209:8787/"))
        self.assertEqual(["http://192.168.0.209:8789/api/panes?x=1"], query["next"])

    def test_ipv6_literal_keeps_brackets(self):
        value, query = self.location("[::1]:8789")
        self.assertTrue(value.startswith("http://[::1]:8787/"))
        self.assertEqual(["http://[::1]:8789/session/default"], query["next"])

    def test_missing_or_invalid_host_falls_back(self):
        value, query = self.location("", "/")
        self.assertTrue(value.startswith("http://127.0.0.1:8787/"))
        self.assertEqual(["http://127.0.0.1:8787/"], query["next"])
        value, _ = self.location("evil/host", "/")
        self.assertTrue(value.startswith("http://127.0.0.1:8787/"))

    def test_redirect_is_302_with_no_store(self):
        response = proxy._redirect_to_login("cell:8789", "GET / HTTP/1.1")
        self.assertTrue(response.startswith(b"HTTP/1.1 302 Found\r\n"))
        self.assertIn(b"Cache-Control: no-store\r\n", response)
        self.assertIn(b"Location: http://cell:8787/?next=", response)

    def test_auth_probe_never_redirects(self):
        live = proxy._auth_probe_response(True)
        gone = proxy._auth_probe_response(False)
        self.assertTrue(live.startswith(b"HTTP/1.1 204 No Content\r\n"))
        self.assertTrue(gone.startswith(b"HTTP/1.1 401 Unauthorized\r\n"))
        self.assertNotIn(b"Location:", live)
        self.assertNotIn(b"Location:", gone)


class SessionLookupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "messages.sqlite3"
        connection = sqlite3.connect(self.db)
        connection.execute("CREATE TABLE sessions(token_hash TEXT, expires_at REAL)")
        self.token = "owner-session-token"
        connection.execute(
            "INSERT INTO sessions VALUES (?,?)",
            (hashlib.sha256(self.token.encode()).hexdigest(), time.time() + 60),
        )
        connection.commit()
        connection.close()
        self.previous = proxy.AUTH_DB
        proxy.AUTH_DB = str(self.db)
        self.addCleanup(lambda: setattr(proxy, "AUTH_DB", self.previous))

    def test_valid_cookie_is_accepted(self):
        self.assertTrue(proxy._session_valid(self.token))

    def test_missing_and_unknown_cookies_are_rejected(self):
        self.assertFalse(proxy._session_valid(""))
        self.assertFalse(proxy._session_valid("not-a-session"))

    def test_expired_cookie_is_rejected(self):
        with sqlite3.connect(self.db) as connection:
            connection.execute(
                "UPDATE sessions SET expires_at=?", (time.time() - 1,)
            )
        self.assertFalse(proxy._session_valid(self.token))

    def test_missing_database_fails_closed(self):
        proxy.AUTH_DB = str(Path(self.temp.name) / "missing.sqlite3")
        self.assertFalse(proxy._session_valid(self.token))


if __name__ == "__main__":
    unittest.main()
