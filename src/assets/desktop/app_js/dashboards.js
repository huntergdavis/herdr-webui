// Top-left "Dashboards" pane and the framed VP desk dashboards.
//
// The Herdr WebUI is the front door for the owner now. The four custom
// dashboards still live in the VP desk, on its own fixed port. The frame URL
// follows the host the owner actually signed in on (the desk session cookie
// is host-bound), exactly like the desk's own /api/herdr-webui rewrite:
// http://<request host>:<desk port>/dash/<name>.
//
// The iframe is same-origin with the desk, not with this page: keep the frame
// cross-origin-clean (no contentWindow access) and let the desk own its auth
// gate. The 8789 proxy is the auth boundary for this shell; see
// scripts/herdr_webui_auth_proxy.py.
(function () {
  const DEFAULT_DESK_PORT = 8787;
  const configuredPort = Number(globalThis.HERDR_DASH_DESK_PORT || DEFAULT_DESK_PORT);
  const DESK_PORT =
    Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536
      ? configuredPort
      : DEFAULT_DESK_PORT;

  const DASHBOARDS = Object.freeze([
    {
      key: "operations",
      label: "Operations",
      title: "Operations",
      description: "Live board · deterministic, 30s refresh",
      icon: "▤",
      path: "/dash/operations",
    },
    {
      key: "play",
      label: "Play Poolrad",
      title: "Play Poolrad",
      description: "Live game · keyboard and save states",
      icon: "▶",
      path: "/dash/play",
    },
    {
      key: "vp",
      label: "VP of Agentry",
      title: "VP of Agentry",
      description: "Agent conversation · owner protected",
      icon: "✦",
      path: "/dash/vp",
    },
  ]);
  const BY_KEY = new Map(DASHBOARDS.map((entry) => [entry.key, entry]));

  function docEl(id) {
    return typeof document !== "undefined" ? document.getElementById(id) : null;
  }

  function hostForUrl(hostname) {
    let value = String(hostname || "").trim();
    if (!value) {
      const loc = globalThis.location;
      value = (loc && loc.hostname) || "127.0.0.1";
    }
    // location.hostname is normally bracketed for IPv6; accept both forms.
    if (value.includes(":") && !value.startsWith("[")) value = `[${value}]`;
    return value;
  }

  function dashboardUrl(key, hostname, port) {
    const entry = BY_KEY.get(String(key || "").toLowerCase());
    if (!entry) return "";
    const deskPort = Number(port || DESK_PORT);
    return `http://${hostForUrl(hostname)}:${deskPort}${entry.path}`;
  }

  function listEntries() {
    return DASHBOARDS.map((entry) => ({ ...entry }));
  }

  const elements = {};

  function refreshElements() {
    elements.main = elements.main || document.querySelector(".main");
    elements.view = elements.view || docEl("dashboardView");
    elements.title = elements.title || docEl("dashboardTitle");
    elements.meta = elements.meta || docEl("dashboardMeta");
    elements.frame = elements.frame || docEl("dashboardFrame");
    elements.nav = elements.nav || docEl("dashboards");
    return elements;
  }

  function setActive(key) {
    const nav = docEl("dashboards");
    if (!nav) return;
    for (const button of nav.querySelectorAll("[data-dashboard]")) {
      const active = button.dataset.dashboard === key;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  }

  function renderNav() {
    const nav = docEl("dashboards");
    if (!nav) return;
    nav.innerHTML = DASHBOARDS.map(
      (entry) =>
        `<button class="dashboard-nav-item" type="button" data-dashboard="${entry.key}" title="${entry.title} — ${entry.description}"><span class="dashboard-nav-icon" aria-hidden="true">${entry.icon}</span><span class="dashboard-nav-text"><strong>${entry.label}</strong><small>${entry.description}</small></span></button>`,
    ).join("");
  }

  function syncShell() {
    if (typeof document === "undefined") return;
    refreshElements();
    const { main, view, frame, title, meta } = elements;
    const entry = state.dashboard ? BY_KEY.get(state.dashboard) : null;
    if (!main || !view) return;
    if (!entry) {
      view.hidden = true;
      main.classList.remove("dashboard-open");
      setActive(null);
      return;
    }
    view.hidden = false;
    main.classList.add("dashboard-open");
    if (title) title.textContent = entry.title;
    if (meta)
      meta.textContent = `${entry.description} · desk ${hostForUrl()}:${DESK_PORT}`;
    if (frame && frame.dataset.dashboard !== entry.key) {
      frame.dataset.dashboard = entry.key;
      frame.src = dashboardUrl(entry.key);
      frame.title = `${entry.title} dashboard`;
    }
    setActive(entry.key);
  }

  function openDashboard(key, options = {}) {
    const entry = BY_KEY.get(String(key || "").toLowerCase());
    if (!entry) return false;
    const changed = state.dashboard !== entry.key;
    state.dashboard = entry.key;
    refreshElements();
    if (changed && elements.frame) {
      elements.frame.dataset.dashboard = entry.key;
      elements.frame.src = dashboardUrl(entry.key);
      elements.frame.title = `${entry.title} dashboard`;
    }
    syncShell();
    if (options.updateHash !== false) {
      const hash = `#dash/${entry.key}`;
      const loc = globalThis.location;
      if (loc && loc.hash !== hash) {
        try {
          globalThis.history.pushState(null, "", hash);
        } catch (_) {
          loc.hash = hash;
        }
      }
    }
    return true;
  }

  function closeDashboard(options = {}) {
    const wasOpen = !!state.dashboard;
    state.dashboard = null;
    refreshElements();
    if (elements.frame) {
      elements.frame.src = "about:blank";
      delete elements.frame.dataset.dashboard;
    }
    syncShell();
    // Removing the frame class reveals the terminal that stayed mounted
    // underneath. Refit once the layout settles; no reconnect is needed.
    if (typeof globalThis.HerdrScheduleTerminalResize === "function")
      globalThis.HerdrScheduleTerminalResize();
    const loc = globalThis.location;
    if (
      options.clearHash !== false &&
      loc &&
      String(loc.hash || "").startsWith("#dash/")
    ) {
      try {
        globalThis.history.replaceState(
          null,
          "",
          `${loc.pathname}${loc.search}`,
        );
      } catch (_) {
        loc.hash = "";
      }
    }
    return wasOpen;
  }

  function reloadDashboard() {
    const entry = state.dashboard ? BY_KEY.get(state.dashboard) : null;
    const frame = docEl("dashboardFrame");
    if (!entry || !frame) return;
    const base = dashboardUrl(entry.key);
    const separator = base.includes("?") ? "&" : "?";
    frame.src = `${base}${separator}reload=${Date.now()}`;
  }

  function popoutDashboard() {
    const entry = state.dashboard ? BY_KEY.get(state.dashboard) : null;
    if (!entry || typeof globalThis.open !== "function") return;
    globalThis.open(dashboardUrl(entry.key), "_blank", "noopener");
  }

  function hashKey() {
    const loc = globalThis.location;
    const match = /^#dash\/([a-z0-9_-]+)$/i.exec(String((loc && loc.hash) || ""));
    return match ? match[1].toLowerCase() : null;
  }

  function applyHash() {
    const key = hashKey();
    if (key && BY_KEY.has(key)) openDashboard(key, { updateHash: false });
    else if (state.dashboard) closeDashboard({ clearHash: false });
  }

  function bind() {
    renderNav();
    const nav = docEl("dashboards");
    if (nav && !nav.dataset.dashboardBound) {
      nav.dataset.dashboardBound = "1";
      nav.addEventListener("click", (event) => {
        const button = event.target && event.target.closest
          ? event.target.closest("[data-dashboard]")
          : null;
        if (!button) return;
        event.preventDefault();
        if (state.dashboard === button.dataset.dashboard) closeDashboard();
        else openDashboard(button.dataset.dashboard);
      });
    }
    const back = docEl("dashboardBack");
    if (back && !back.dataset.dashboardBound) {
      back.dataset.dashboardBound = "1";
      back.addEventListener("click", () => closeDashboard());
    }
    const reload = docEl("dashboardReload");
    if (reload && !reload.dataset.dashboardBound) {
      reload.dataset.dashboardBound = "1";
      reload.addEventListener("click", reloadDashboard);
    }
    const popout = docEl("dashboardPopout");
    if (popout && !popout.dataset.dashboardBound) {
      popout.dataset.dashboardBound = "1";
      popout.addEventListener("click", popoutDashboard);
    }
    if (!globalThis.__herdrDashboardHashBound) {
      globalThis.__herdrDashboardHashBound = true;
      globalThis.addEventListener("hashchange", applyHash);
      globalThis.addEventListener("popstate", applyHash);
    }
    // Enforce the HTML's initial hidden state even before a hash selects a
    // dashboard, so no stale frame can paint on boot.
    syncShell();
    applyHash();
  }

  globalThis.HerdrDashboards = {
    entries: listEntries,
    url: dashboardUrl,
    open: openDashboard,
    close: closeDashboard,
    sync: syncShell,
    deskPort: DESK_PORT,
  };
  globalThis.HerdrCloseDashboard = closeDashboard;
  globalThis.HerdrSyncDashboardShell = syncShell;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", bind, { once: true });
    else bind();
  }
})();
