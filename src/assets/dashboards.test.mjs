import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// The top-left Dashboards pane frames the four VP desk dashboards. This test
// pins the advertised list, the host-agnostic URL rule, and the show/hide
// behavior that keeps the terminal shell mounted underneath.
const source = readFileSync(
  new URL("./desktop/app_js/dashboards.js", import.meta.url),
  "utf8",
);
const html = readFileSync(new URL("./app.html", import.meta.url), "utf8");

function fakeClassList() {
  const values = new Set();
  return {
    add: (name) => values.add(name),
    remove: (name) => values.delete(name),
    contains: (name) => values.has(name),
    toggle: (name, force) => {
      const on = force === undefined ? !values.has(name) : !!force;
      if (on) values.add(name);
      else values.delete(name);
      return on;
    },
  };
}

function fakeElement(id) {
  const attributes = new Map();
  const node = {
    id,
    classList: fakeClassList(),
    dataset: {},
    style: {},
    hidden: false,
    textContent: "",
    innerHTML: "",
    src: "",
    title: "",
    addEventListener() {},
    setAttribute(name, value) {
      attributes.set(String(name), String(value));
    },
    getAttribute(name) {
      return attributes.has(String(name)) ? attributes.get(String(name)) : null;
    },
    removeAttribute(name) {
      attributes.delete(String(name));
    },
    closest() {
      return this;
    },
    focus() {},
  };
  return node;
}

function makeContext({ hostname = "cell", hash = "" } = {}) {
  const elements = new Map();
  const buttons = new Map();
  const buttonFor = (key) => {
    if (!buttons.has(key)) {
      const button = fakeElement(`dashboard-${key}`);
      button.dataset.dashboard = key;
      buttons.set(key, button);
    }
    return buttons.get(key);
  };
  const nav = fakeElement("dashboards");
  for (const key of ["operations", "play", "vp"]) buttonFor(key);
  nav.querySelectorAll = (selector) =>
    selector === "[data-dashboard]" ? [...buttons.values()] : [];
  elements.set("dashboards", nav);
  const main = fakeElement("main");
  main.classList = fakeClassList();
  const document = {
    readyState: "complete",
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement(id));
      return elements.get(id);
    },
    querySelector(selector) {
      return selector === ".main" ? main : null;
    },
    addEventListener() {},
  };
  const location = {
    hostname,
    hash,
    pathname: "/",
    search: "",
  };
  const history = {
    pushState(_state, _title, url) {
      if (typeof url === "string" && url.startsWith("#")) location.hash = url;
    },
    replaceState() {},
  };
  const ctx = {
    console,
    document,
    location,
    history,
    state: { dashboard: null },
    addEventListener() {},
    setTimeout,
    clearTimeout,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "dashboards.js" });
  return { ctx, elements, buttons, buttonFor, main, location };
}

describe("dashboards pane", () => {
  it("renders in the top-left sidebar with the four exact entries", () => {
    assert.match(html, /class="dashboards-section"/);
    assert.match(html, /id="dashboards"/);
    assert.ok(
      html.indexOf('id="dashboardsSection"') < html.indexOf('id="workspaces"'),
      "dashboards nav must precede the workspaces list",
    );
    const { ctx } = makeContext();
    const entries = ctx.HerdrDashboards.entries();
    assert.deepEqual(
      Array.from(entries, (entry) => String(entry.label)),
      ["Operations", "Play Poolrad", "VP of Agentry"],
    );
    assert.deepEqual(
      Array.from(entries, (entry) => String(entry.path)),
      ["/dash/operations", "/dash/play", "/dash/vp"],
    );
  });

  it("keeps the frame host-agnostic on the fixed desk port", () => {
    const { ctx } = makeContext({ hostname: "cell" });
    assert.equal(
      ctx.HerdrDashboards.url("play"),
      "http://cell:8787/dash/play",
    );
    assert.equal(
      ctx.HerdrDashboards.url("operations", "192.168.0.209"),
      "http://192.168.0.209:8787/dash/operations",
    );
    assert.equal(
      ctx.HerdrDashboards.url("play", "localhost"),
      "http://localhost:8787/dash/play",
    );
    assert.equal(ctx.HerdrDashboards.url("nope"), "");
  });

  it("opens inside the shell without tearing down the terminal pane", () => {
    const { ctx, elements, buttonFor, main } = makeContext();
    const frame = elements.get("dashboardFrame") || ctx.document.getElementById("dashboardFrame");
    const view = ctx.document.getElementById("dashboardView");
    const title = ctx.document.getElementById("dashboardTitle");
    assert.equal(view.hidden, true);
    ctx.HerdrDashboards.open("play");
    assert.equal(ctx.state.dashboard, "play");
    assert.equal(view.hidden, false);
    assert.equal(main.classList.contains("dashboard-open"), true);
    assert.equal(frame.src, "http://cell:8787/dash/play");
    assert.equal(title.textContent, "Play Poolrad");
    assert.equal(buttonFor("play").classList.contains("active"), true);

    ctx.HerdrDashboards.close();
    assert.equal(ctx.state.dashboard, null);
    assert.equal(view.hidden, true);
    assert.equal(main.classList.contains("dashboard-open"), false);
    assert.equal(frame.src, "about:blank");
    assert.equal(buttonFor("play").classList.contains("active"), false);
  });

  it("restores a dashboard from the URL hash", () => {
    const { ctx } = makeContext({ hash: "#dash/operations" });
    assert.equal(ctx.state.dashboard, "operations");
    assert.equal(
      ctx.document.getElementById("dashboardFrame").src,
      "http://cell:8787/dash/operations",
    );
  });

  it("keeps a password gate in the shell before any dashboard frame loads", () => {
    // The shell is proxied behind the cookie check; unauthenticated requests
    // never reach this HTML. Pin the server-side redirect contract in
    // scripts/herdr_webui_auth_proxy_test.py and the absence of any
    // unauthenticated dashboard shortcut here.
    assert.doesNotMatch(html, /dashboardFrame[^>]+src=/);
    assert.doesNotMatch(html, /\/dash\/poolrad/);
  });
});
