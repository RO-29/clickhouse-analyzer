# Landing page (ch-analyzer.pages.dev)

`index.html` is the marketing/landing page served at https://ch-analyzer.pages.dev/.
It is a **single self-contained file** (inline CSS, no external requests, no build
step) so it deploys as a static page anywhere.

## Why this exists

The previously-deployed landing page was hand-built out-of-band and its source was
**not in this repo**, so it drifted badly from reality (wrong Slack commands, wrong
version support, wrong collector/view counts, and a fabricated "console"). This file
replaces it and is the source of truth. Keep it accurate: it mirrors the real app's
design tokens (`web/frontend/src/index.css`) and states only capabilities the code
actually ships.

## Deploy (Cloudflare Pages)

This directory is the Pages project root. No framework, no build command.

```
# Wrangler (one-off)
npx wrangler pages deploy web/landing --project-name ch-analyzer

# or point a Pages project at the repo with:
#   Build command:        (none)
#   Build output dir:      web/landing
```

## The "Live demo" link

The hero and footer CTAs currently scroll to the in-page interactive Overview
(`#demo`), which is a faithful CSS rebuild of the real dashboard and needs no
backend. To wire the button to a hosted instance instead, replace the `href="#demo"`
CTAs with the demo URL once the Phase 3 backend (a real ch-analyzer pointed at a
free-tier ClickHouse) is stood up. See the repo's demo docs for that wiring.
