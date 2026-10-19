#!/usr/bin/env python3
"""Browser acceptance for owner #941/#943 always-visible grabbable scrollbars.

Requires Playwright + Chromium. On this host:

  xvfb-run -a /home/hunter/workspace/vp-of-agentry/.venv/bin/python \
    scripts/e2e/scrollbars-acceptance.py

The script logs into the VP desk, opens the Herdr shell and all four framed
dashboard routes at 1440x900 and 390x844, measures the rendered scrollbar
width, drags a thumb, clicks the track, and writes screenshots. It asserts a
non-zero 14px-class scrollbar; Chromium must be headful under Xvfb because
headless Chromium hides overlay scrollbars from layout.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

PROBE_ID = "__herdr_scroll_probe"
PROBE_JS = """
() => {
  document.getElementById('__herdr_scroll_probe')?.remove();
  const d = document.createElement('div');
  d.id = '__herdr_scroll_probe';
  d.style.cssText = 'position:fixed;right:12px;bottom:12px;width:260px;height:180px;'
    + 'overflow-y:scroll;z-index:2147483647;background:#1e1e2e;'
    + 'color:#cdd6f4;font:12px monospace';
  d.innerHTML = '<div style="height:20000px;background:linear-gradient(#45475a,#89b4fa)">probe</div>';
  document.body.appendChild(d);
  const cs = getComputedStyle(d);
  return {
    width: d.offsetWidth - d.clientWidth,
    height: d.offsetHeight - d.clientHeight,
    scrollbarWidth: cs.scrollbarWidth,
    scrollbarColor: cs.scrollbarColor,
  };
}
"""
SCROLL_TOP_JS = "() => document.getElementById('__herdr_scroll_probe')?.scrollTop || 0"
RESET_JS = "() => { const e=document.getElementById('__herdr_scroll_probe'); if(e) e.scrollTop=0; }"


def login(page, desk: str, password: str) -> None:
    page.goto(desk, wait_until="domcontentloaded")
    page.fill('input[type="password"]', password)
    page.get_by_role("button", name="Open desk").click()
    page.wait_for_selector(".sidebar, .dashboard-view, .shell", timeout=15000)


def probe(page) -> dict:
    page.evaluate(PROBE_JS)
    page.wait_for_timeout(100)
    box = page.locator(f"#{PROBE_ID}").bounding_box()
    assert box, "probe did not render"
    page.evaluate(RESET_JS)
    x = box["x"] + box["width"] - 7
    page.mouse.move(x, box["y"] + 24)
    page.mouse.down()
    page.mouse.move(x, box["y"] + 110, steps=12)
    page.mouse.up()
    page.wait_for_timeout(300)
    dragged = page.evaluate(SCROLL_TOP_JS)
    page.evaluate(RESET_JS)
    page.wait_for_timeout(100)
    page.mouse.click(x, box["y"] + box["height"] - 6)
    page.wait_for_timeout(400)
    track_clicked = page.evaluate(SCROLL_TOP_JS)
    metrics = page.evaluate(
        """() => {
          const d = document.getElementById('__herdr_scroll_probe');
          const cs = getComputedStyle(d);
          return { width: d.offsetWidth - d.clientWidth,
                   scrollbarWidth: cs.scrollbarWidth,
                   scrollbarColor: cs.scrollbarColor };
        }"""
    )
    metrics.update({"dragged": dragged, "trackClicked": track_clicked})
    return metrics


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shell", default="http://192.168.0.209:8789/")
    parser.add_argument("--desk", default="http://192.168.0.209:8787")
    parser.add_argument(
        "--password-file",
        default="/home/hunter/workspace/vp-of-agentry/data/owner-credentials",
    )
    parser.add_argument("--out", default=f"/tmp/herdr-scrollbars-{int(time.time())}")
    args = parser.parse_args()
    password = ""
    for line in Path(args.password_file).read_text().splitlines():
        if line.startswith("Password: "):
            password = line.removeprefix("Password: ")
    if not password:
        print(f"no Password line in {args.password_file}", file=sys.stderr)
        return 1
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    routes = ["poolrad", "operations", "play", "vp"]
    results: list[dict] = []
    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, args=["--disable-features=OverlayScrollbar"])
        for width, height in ((1440, 900), (390, 844)):
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()
            login(page, args.desk, password)
            for name, url in [("shell", args.shell)] + [
                (f"dash-{route}", f"{args.desk}/dash/{route}") for route in routes
            ]:
                page.goto(url, wait_until="domcontentloaded")
                page.wait_for_timeout(800)
                label = f"{name}-{width}x{height}"
                clean = out / f"{label}-page.png"
                page.screenshot(path=str(clean), full_page=False)
                metrics = probe(page)
                probe_shot = out / f"{label}-probe.png"
                page.screenshot(path=str(probe_shot), full_page=False)
                page.evaluate("document.getElementById('__herdr_scroll_probe')?.remove()")
                ok = metrics["width"] >= 12 and metrics["dragged"] > 0 and metrics["trackClicked"] > 0
                if not ok:
                    failures.append(f"{label}: {metrics}")
                results.append({"page": label, "ok": ok, **metrics,
                                "screenshot": str(probe_shot), "pageScreenshot": str(clean)})
                print(json.dumps(results[-1]))
            context.close()
        browser.close()
    (out / "results.json").write_text(json.dumps(results, indent=2))
    print(f"results: {out / 'results.json'}")
    if failures:
        print("FAILURES:", *failures, sep="\n  ", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
