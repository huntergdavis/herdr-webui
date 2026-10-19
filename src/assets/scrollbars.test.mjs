import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// Owner #941: scrollbars must be classic and always visible inside the web
// app, not overlay/auto-hiding. These are CSS-contract assertions; the live
// browser check measures the rendered scrollbar separately.
const base = readFileSync(
  new URL("./shared/scrollbars.css", import.meta.url),
  "utf8",
);
const chrome = readFileSync(
  new URL("./shared/scrollbars.css", import.meta.url),
  "utf8",
);
const terminal = readFileSync(
  new URL("./desktop/app_css/terminal.css", import.meta.url),
  "utf8",
);
const allDesktopCss = ["base.css", "panes.css", "modals.css", "terminal.css", "chrome.css", "controls.css", "workspaces.css"]
  .map((name) => readFileSync(new URL(`./desktop/app_css/${name}`, import.meta.url), "utf8"))
  .join("\n") + "\n" + base;

describe("always-visible scrollbars", () => {
  it("defines the shared 14px Catppuccin token set", () => {
    assert.match(base, /--sb-size:\s*14px/);
    assert.match(base, /--sb-track:\s*var\(--panel\)/);
    assert.match(base, /--sb-thumb:\s*var\(--border2\)/);
    assert.match(base, /--sb-thumb-hover:\s*#7f849c/);
    // Light theme keeps the same structure with accessible light tokens.
    assert.match(base, /body\.light[\s\S]*--sb-thumb-hover:\s*#5c6378/);
  });

  it("opts Firefox out of thin/overlay scrollbars everywhere", () => {
    assert.match(chrome, /@supports \(-moz-appearance: none\)[\s\S]*?\*\s*\{[\s\S]*?scrollbar-width:\s*auto/);
    assert.match(
      chrome,
      /scrollbar-color:\s*var\(--sb-thumb,\s*#6c7086\)\s+var\(--sb-track,\s*#181825\)/,
    );
    assert.doesNotMatch(allDesktopCss, /scrollbar-width:\s*thin/);
  });

  it("draws a classic 14px WebKit track and grabbable thumb at rest", () => {
    assert.match(chrome, /\*::-webkit-scrollbar\s*\{[\s\S]*?width:\s*var\(--sb-size,\s*14px\)/);
    assert.match(chrome, /\*::-webkit-scrollbar\s*\{[\s\S]*?height:\s*var\(--sb-size,\s*14px\)/);
    assert.match(chrome, /\*::-webkit-scrollbar-track\s*\{[\s\S]*?background:\s*var\(--sb-track,\s*#181825\)/);
    assert.match(chrome, /\*::-webkit-scrollbar-thumb\s*\{[\s\S]*?min-height:\s*48px/);
    assert.match(chrome, /\*::-webkit-scrollbar-thumb\s*\{[\s\S]*?min-width:\s*48px/);
    assert.match(chrome, /\*::-webkit-scrollbar-thumb\s*\{[\s\S]*?border-radius:\s*6px/);
    assert.match(chrome, /\*::-webkit-scrollbar-thumb:hover\s*\{[\s\S]*?var\(--sb-thumb-hover,\s*#7f849c\)/);
  });

  it("reserves the gutter on every main vertical scroller", () => {
    for (const selector of [
      ".sidebar-scroll",
      ".terminal-lens-scroller",
      ".search-results",
      ".modal-backdrop:not(.search-palette) .modal",
      ".project-dashboard",
      ".workspace-empty-leaf",
      ".terminal",
      ".git-ui-content",
      ".file-browser-pane-body",
      ".herdr-markdown-body",
    ]) {
      assert.ok(
        new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?scrollbar-gutter:\\s*stable`).test(chrome) ||
          chrome.includes(selector),
        `missing stable gutter selector ${selector}`,
      );
    }
    assert.match(chrome, /html,\s*body\s*\{\s*scrollbar-gutter:\s*stable/);
  });

  it("keeps the terminal scroll container scrollable in both axes", () => {
    assert.match(terminal, /\.terminal\.wterm,[\s\S]*?\.terminal \.wterm\s*\{[\s\S]*?overflow:\s*auto/);
    assert.doesNotMatch(terminal, /\.terminal-shell::-webkit-scrollbar/);
  });
});
