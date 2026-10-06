# 0012. Mobile-first UI with Tailwind and shadcn/ui; each shop brands its pages

- **Status:** Accepted
- **Date:** 2026-10-06
- **Decided by:** Simon, after reviewing a design canvas with three directions (bold app-like was chosen)

## Context

Most buyers open a drop link on their phone, often from Instagram or WhatsApp. The first UI was one plain stylesheet, and every shop looked the same: the profile had `logoUrl` and `colour`, but no page used them and nothing could be uploaded.

## Decision

- **Look:** a mobile-first "bold app-like" design. Big rounded cards, a sticky bottom button, the shop's colour as the hero. DropDeck's own pages (console, sign-in) use ink and a volt accent.
- **Tooling:** Tailwind v4 (config in `apps/web/app/globals.css`) and shadcn/ui-style components copied into `apps/web/components/ui/` (Radix primitives, `class-variance-authority`). Fonts are self-hosted from npm (Fontsource), so builds need no network.
- **Branding per shop:** logo, cover banner, colour, theme (light, dark, or match the phone) and tagline live on the profile. `lib/brand.ts` turns the colour into readable pairs: button text is white unless the colour is too light, fills are nudged until text reaches 4.5:1, and very dark colours are lifted in dark mode.
- **Uploads:** the console shrinks the image in the browser, then `POST /m/uploads` sends it as base64 JSON. The Lambda checks the bytes (PNG, JPEG or WebP only), stores it at `b/{tenant}/{sha256}.{ext}` with a one-year immutable cache, and returns the path.
- **Branding reaches live pages:** a profile save rewrites `drop.json` for the shop's Scheduled and Live drops.
- **Shop page:** `/s/{slug}/` is one static page reading `s/{slug}/shop.json`, like the drop page. Slugs are unique through a `SLUG#` item, written in the same transaction as the profile.
- **Sign-in page:** Cognito managed login (version 2) with a DropDeck style. It is one brand for everyone, since sign-in happens before we know the shop.

## Options rejected

- **Presigned S3 uploads** — need bucket CORS, cannot check the bytes before they land, and cannot use a content-hash key. Revisit only if images over 1 MB are needed.
- **Plain CSS tokens** — less tooling, but slower to build polished components (sheets, menus, code input).
- **A font and button-style picker per shop** — more choices than small shops need; colour, theme, logo and cover carry the brand.
- **Per-shop sign-in branding** — Cognito styles one app client, and merchants sign in to DropDeck, not to a shop.

## Consequences

- A profile save costs one write per published drop plus one `shop.json` write. That is a handful of S3 writes at our scale, and the merchant function's timeout is 15 s to cover it.
- Pages show new branding within about a minute (the `drop.json` and `shop.json` cache).
- Uploaded images are never deleted. They are small, there is a cap of 100 uploads per shop per day, and replaced images simply stop being referenced.
- The Essentials Cognito plan is pinned (managed login needs it). It bills per monthly active user with a free tier, never by the hour.

## Change from the preliminary report

New. The report described a single generic drop page; shop pages, branding and uploads were not in it.
