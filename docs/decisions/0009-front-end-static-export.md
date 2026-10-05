# 0009. Next.js static export with one generic drop page

- **Status:** Accepted
- **Date:** 2026-10-05
- **Decided by:** Simon, confirming the team's workflow review

## Context

Drops are created at run time; a static export cannot have per-drop routes without a rebuild.

## Decision

One page at `/d/index.html` serves every drop. A CloudFront Function rewrites `/d/{tenant}/{drop}` to it; the page reads `drop.json` and polls `state.json` at fixed URLs. Runtime settings come from `/config.json` written at deploy.

## Options rejected

- **Vite SPA** — Fine technically; a change from the report with no gain.
- **Write an HTML file per drop** — Couples publishing to page templates; JSON is enough.

## Consequences

Publishing a drop is a JSON write; no build per drop.

## Change from the preliminary report

As in the preliminary report; mechanism specified.
