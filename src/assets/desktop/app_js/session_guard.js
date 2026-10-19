// Session expiry guard for the Herdr WebUI shell.
//
// The 8789 proxy is the auth boundary: unauthenticated document/API/WebSocket
// requests redirect to the VP desk password UI. That covers boots and
// reconnects, but an already-open shell would otherwise keep its terminal on
// screen after the desk session expires. Poll a same-origin probe and send the
// browser to the desk login with the current URL preserved as `next`.
(function () {
  const DEFAULT_DESK_PORT = 8787;
  const configuredPort = Number(globalThis.HERDR_DASH_DESK_PORT || DEFAULT_DESK_PORT);
  const DESK_PORT =
    Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536
      ? configuredPort
      : DEFAULT_DESK_PORT;
  const POLL_MS = 30000;

  function hostForUrl(hostname) {
    let value = String(hostname || "").trim();
    if (!value) {
      const loc = globalThis.location;
      value = (loc && loc.hostname) || "127.0.0.1";
    }
    if (value.includes(":") && !value.startsWith("[")) value = `[${value}]`;
    return value;
  }

  function loginUrl(loc, deskPort) {
    const location = loc || globalThis.location || {};
    const port = Number(deskPort || DESK_PORT);
    const host = hostForUrl(location.hostname);
    const next = String(location.href || "/");
    return `http://${host}:${port}/?next=${encodeURIComponent(next)}`;
  }

  let checking = false;

  async function check() {
    if (checking || typeof globalThis.fetch !== "function") return;
    checking = true;
    try {
      const response = await globalThis.fetch("/__herdr_auth", {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "manual",
      });
      if (response && response.status === 401 && globalThis.location) {
        globalThis.location.replace(loginUrl(globalThis.location));
      }
    } catch (_) {
      // A transient network failure must not eject the owner mid-session.
    } finally {
      checking = false;
    }
  }

  function start() {
    if (globalThis.__herdrSessionGuardStarted) return;
    globalThis.__herdrSessionGuardStarted = true;
    globalThis.setInterval(check, POLL_MS);
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) check();
      });
    }
  }

  globalThis.HerdrSessionGuard = { loginUrl, check, start, pollMs: POLL_MS };
  if (typeof document !== "undefined") {
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  }
})();
