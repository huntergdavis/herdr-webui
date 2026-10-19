import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("./desktop/app_js/session_guard.js", import.meta.url),
  "utf8",
);

function makeContext({ hostname = "cell", href = "http://cell:8789/session/default", fetchImpl } = {}) {
  const replaced = [];
  const location = {
    hostname,
    href,
    replace(url) {
      replaced.push(url);
    },
  };
  const ctx = {
    console,
    document: {
      readyState: "complete",
      hidden: false,
      addEventListener() {},
    },
    location,
    fetch: fetchImpl || (async () => ({ status: 204 })),
    setInterval() {},
    encodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "session_guard.js" });
  return { ctx, replaced };
}

describe("session guard", () => {
  it("builds a desk login URL on the signed-in host", () => {
    const { ctx } = makeContext();
    assert.equal(
      ctx.HerdrSessionGuard.loginUrl({
        hostname: "cell",
        href: "http://cell:8789/session/default",
      }),
      "http://cell:8787/?next=http%3A%2F%2Fcell%3A8789%2Fsession%2Fdefault",
    );
    assert.equal(
      ctx.HerdrSessionGuard.loginUrl({
        hostname: "192.168.0.209",
        href: "http://192.168.0.209:8789/",
      }),
      "http://192.168.0.209:8787/?next=http%3A%2F%2F192.168.0.209%3A8789%2F",
    );
  });

  it("redirects to the password UI when the probe says the session is gone", async () => {
    const { ctx, replaced } = makeContext({
      fetchImpl: async () => ({ status: 401 }),
    });
    await ctx.HerdrSessionGuard.check();
    assert.deepEqual(replaced, [
      "http://cell:8787/?next=http%3A%2F%2Fcell%3A8789%2Fsession%2Fdefault",
    ]);
  });

  it("keeps the shell open while the session is alive", async () => {
    const { ctx, replaced } = makeContext({
      fetchImpl: async () => ({ status: 204 }),
    });
    await ctx.HerdrSessionGuard.check();
    assert.deepEqual(replaced, []);
  });

  it("does not eject the owner on a transient probe failure", async () => {
    const { ctx, replaced } = makeContext({
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    await ctx.HerdrSessionGuard.check();
    assert.deepEqual(replaced, []);
  });
});
