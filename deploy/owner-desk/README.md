# Herdr WebUI as the VP desk terminal UI (owner #921 / task t17)

This fork runs upstream `herdr-webui` (0.7.16) against the **live external
herdr daemon** and puts the full terminal UI behind the VP desk's existing
owner login.

## Compatibility

Upstream WebUI 0.4.13+ — including this 0.7.16 build — speaks herdr's
private client protocol **22** and requires herdr **0.9.0+**. The live daemon
was upgraded from 0.7.4 (protocol 16) to **0.9.5 (protocol 22)** on
2026-10-19, so no protocol shim is needed.

Verify before deploying:

```sh
herdr --version
herdr status          # client/server protocol must both be 22
```

If herdr is ever downgraded below 0.9.0, this build will not attach. The
WebUI reports the mismatch instead of silently showing an empty pane list.
For 0.7.x you would need the protocol-16 fallback from WebUI v0.4.12
(`MIN_SUPPORTED_PROTOCOL_VERSION = 16`); do not mix that branch with this
one.

## Layout

| Piece | Bind | Purpose |
| --- | --- | --- |
| `vp-herdr-webui.service` | `127.0.0.1:8788` | Upstream WebUI in `--backend-mode external-herdr`. Loopback only; its default localhost trust is never exposed. |
| `vp-herdr-webui-proxy.service` | `0.0.0.0:8789` | Raw TCP/WebSocket proxy. Validates the desk's `vp_session` cookie against `vp-of-agenty/data/messages.sqlite3` before forwarding to 8788. |
| VP desk | `0.0.0.0:8787` | Existing owner login. `GET /api/herdr-webui` returns the iframe URL from `VP_HERDR_WEBUI_URL`. |

The desk's "Herdr web UI" nav item embeds `http://<desk-host>:8789/`.
Cookies are host-scoped, not port-scoped, so the iframe already carries the
owner's desk session; no second login and no terminal exposed without auth.

## Install / run

```sh
# 1. Build (cap jobs on a busy host; 2 is enough)
cd /home/hunter/workspace/herdr-webui
CARGO_BUILD_JOBS=2 CMAKE_BUILD_PARALLEL_LEVEL=2 cargo build --release

# 2. Services
mkdir -p ~/.config/systemd/user
cp deploy/owner-desk/vp-herdr-webui.service \
   deploy/owner-desk/vp-herdr-webui-proxy.service \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vp-herdr-webui.service vp-herdr-webui-proxy.service

# 3. Point the desk at the authenticated proxy and restart only the desk
#    (the service unit reads the environment; edit the unit or run.sh)
#    VP_HERDR_WEBUI_URL=http://192.168.0.209:8789/
systemctl --user restart vp-of-agentry.service
```

Rollback: stop and disable the two new units. The VP desk itself is
unaffected; removing `VP_HERDR_WEBUI_URL` makes its Herdr view show the
"not configured" state. No live herdr pane is restarted by either unit.

## API verification without a browser

```sh
# WebUI loopback (no auth expected from loopback)
curl -s http://127.0.0.1:8788/api/version
curl -s http://127.0.0.1:8788/api/sessions

# Authenticated proxy: 401 without the desk cookie, desk app with it
curl -si http://192.168.0.209:8789/ | head -1
curl -si -H "Cookie: vp_session=$VP_SESSION" http://192.168.0.209:8789/ | head -1
```

The WebUI's session list must include the existing workspaces/panes
(`w9`, `w8`, `wV`, ...). Opening a pane in the UI attaches over WebSocket
`/ws/terminal`; the proxy forwards the upgrade after the cookie check.
