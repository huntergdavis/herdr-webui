# Always-visible grabbable scrollbars (owner #941/#943)

Acceptance evidence for t21. Generated with:

```sh
xvfb-run -a /home/hunter/workspace/vp-of-agentry/.venv/bin/python \
  scripts/e2e/scrollbars-acceptance.py --out /tmp/herdr-scrollbars-t21b
```

Headed Chromium under Xvfb is required: headless Chromium hides native
scrollbars from layout/hit-testing, so width/drag assertions are meaningless
there (same caveat the dashboard lane reported).

Measured on every screenshot in this directory:

| Check | Result |
| --- | --- |
| scrollbar width | **14px** (`offsetWidth - clientWidth`, no border) |
| rendered thumb length | **48px** (pixel sample of the middle of the 14px strip on a 20,000px scroller) |
| thumb drag | `scrollTop` 0 -> ~12,913 on a 20,000px scroller |
| track click | `scrollTop` 0 -> 157 |
| CSS path | `*::-webkit-scrollbar` (Chromium/Safari); Firefox properties scoped behind `@supports (-moz-appearance: none)` |
| contrast | track `#181825`, thumb `#6c7086` = 3.59:1, hover `#7f849c` = 4.75:1 |

Screenshots: shell and all four framed dashboards at 1440x900 and 390x844.
The probe box in each shot is the 20,000px scroller used for the measurement;
the real shell and dashboard scrollers use the same global CSS.
