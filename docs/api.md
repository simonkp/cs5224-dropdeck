# API contract

What the front end, the evaluation scripts and anyone extending DropDeck can rely on. Types live in
`packages/shared/src/types.ts`; when this file and the code disagree, the code wins and this file is the bug.

Every stage serves its own `/config.json` with the URLs below. Times are ISO-8601 UTC strings unless noted;
money is integer cents (SGD).

## Errors

Every error body is `{ code, message, retryAfter? }` (`retryAfter` in seconds). Unexpected failures are
`500 { code: "INTERNAL" }` and are logged with a stack.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION` | 400 | Bad input; `message` says which field |
| `OTP_INVALID` | 400 | Wrong, expired or missing email code, or a different address from the one the code went to |
| `UNAUTHORIZED` | 401 | No merchant identity |
| `BAD_TOKEN` | 401 | Ticket or hold token forged, expired, or for another drop or hold |
| `NOT_ADMITTED` | 403 | Not this ticket's turn yet; retry after `retryAfter` |
| `NOT_FOUND` | 404 | No such drop, order or route, or it belongs to another merchant |
| `NOT_LIVE` | 409 | Queue not open yet (`retryAfter` until it opens), or the drop has ended |
| `VARIANT_SOLD_OUT` | 409 | No shard has the quantity left |
| `LIMIT_REACHED` | 409 | This email already has an order for this drop |
| `LOCKED_FOR_EDIT` | 409 | Field cannot change in the drop's current state |
| `INVALID_STATE` | 409 | Lifecycle conflict (e.g. scheduling a non-draft, checkout on a cancelled drop), or the profile changed since it was read |
| `SLUG_TAKEN` | 409 | Another shop already has that shop link |
| `ADMISSION_EXPIRED` | 410 | The ticket's claim window has passed; join again |
| `HOLD_EXPIRED` | 410 | The hold ran out or was released |
| `OTP_LOCKED` | 429 | Five wrong codes, or three codes sent, for this hold |
| `RATE_LIMITED` | 429 | Code requested again within 30 s, or the day's 100 image uploads are used up |
| `NOT_IMPLEMENTED` | 501 | Unused since Phase 4 |

`SOLD_OUT` and `TENANT_BUDGET` are reserved and not returned today.

## Public files (CloudFront, no auth)

| Path | Cache | Written by |
| --- | --- | --- |
| `/config.json` | invalidated on deploy | CDK: `{ apiUrl, userPoolId, userPoolClientId, authDomain, stage, mailMode, siteUrl }` |
| `/d/{tenantId}/{dropId}/` | static page | Next.js export, rewritten to `/d/index.html` |
| `/d/{tenantId}/{dropId}/drop.json` | 30 s (max 60) | merchant API on schedule, on edits, and on every profile save (Scheduled and Live drops) |
| `/d/{tenantId}/{dropId}/state.json` | 2 s (1–5) | merchant API before open and on cancel; controller every tick while Live |
| `/s/{slug}/` | static page | Next.js export, rewritten to `/s/index.html` |
| `/s/{slug}/shop.json` | 30 s (max 60) | merchant API on profile save, schedule, unschedule, cancel and edits of Scheduled drops; controller on open and close |
| `/b/{tenantId}/{hash}.{png,jpg,webp}` | 1 year, immutable | `POST /m/uploads`; content-addressed, never overwritten |

A missing file is `403` (S3 behind origin access control), not `404`; pages treat both as "not found".

`drop.json` (`PublicDrop`): `tenantId, dropId, merchant{name, slug?, logoUrl?, colour?, theme, coverUrl?, tagline?},
title, description, imageUrl?, variants[{id, name, priceCents}], openAt, endAt, entryOpensAt, perBuyerLimit, holdSec,
admitWindowSec, verification`. `merchant.slug` is present once the shop page exists. Image fields are root-relative
paths (`/b/...`); resolve them against `siteUrl` when the page runs elsewhere (`next dev`). Closed and Cancelled drops
keep the branding they were published with.

`shop.json` (`PublicShop`): `tenantId, merchant{...as above}, generatedAt, drops[{dropId, url, title, imageUrl?,
state: Scheduled | Live | Closed, entryOpensAt, openAt, endAt, fromPriceCents}]`: Live first, then up to 20
Scheduled soonest first, then up to 6 drops closed in the last 30 days, newest first. Drafts and cancelled drops never
appear. The file can be a minute old, so show a Scheduled drop as live once its `entryOpensAt` has passed.

`state.json` (`PublicState`): `state, serverTime, rThreshold (0..1), nWatermark, earlyCount (null until frozen),
soldOut{variantId: bool}`. A buyer with draw position `r` is admitted when `earlyCount !== null && r <= rThreshold`;
a late ticket `n` when `n < nWatermark`. The claim endpoint is the real gate.

**Poll `state.json` at its fixed URL. Never add a query string**: the cache key ignores it, but a unique URL
per poll is what turns a crowd into origin traffic. Take the clock offset from the `Date` + `Age` response headers.

## Buyer API (`{apiUrl}`, no login)

Tokens are HMAC-signed and stateless (decision 0006). Hold tokens travel as `Authorization: Bearer <hold>`.

### `POST /api/d/{tenantId}/{dropId}/ticket`

No body. `201 { ticket, r? | n?, admissionStartsAt }`. Before `openAt + graceSec` the ticket carries a random
draw position `r`; after it, a sequence number `n` (block-allocated: numbers interleave across Lambda
instances by up to one block). Errors: `NOT_LIVE` (before `entryOpensAt`, with `retryAfter`; or after `endAt`),
`NOT_FOUND`.

### `POST /api/d/{tenantId}/{dropId}/claim`

`{ ticket, variantId, qty? = 1 }`, `qty` ≤ `perBuyerLimit`.
`201 { hold, holdId, expiresAt, variantId, qty }`; a retried claim for the same ticket returns the same hold
with `200`. Errors: `NOT_ADMITTED` (+`retryAfter`), `ADMISSION_EXPIRED`, `VARIANT_SOLD_OUT`, `BAD_TOKEN`,
`NOT_LIVE`, `VALIDATION`, `INVALID_STATE` (ticket already has an order), `HOLD_EXPIRED`.

The claim window opens at the ticket's admission time or its issue time, whichever is later, and lasts
`admitWindowSec`.

### `GET /api/holds/{holdId}`

Resume after a refresh. Active: `{ state: "active" | "expired", expiresAt, variantId, qty, verification, codeSent }`.
Confirmed: the confirmation body below.

### `POST /api/holds/{holdId}/otp` (drops with `verification: "email"`)

`{ email }` → `200 { sentTo (masked), resendAfterSec: 30, sendsLeft, devCode? }`. `devCode` is present only in log
mode (no sender configured). Errors: `LIMIT_REACHED` (address already ordered; nothing is sent),
`RATE_LIMITED` (+`retryAfter`), `OTP_LOCKED` (3 sends used), `HOLD_EXPIRED`, `VALIDATION`, `INVALID_STATE`.

### `POST /api/holds/{holdId}/confirm`

`{ name, email, code? }` (`code` required when verification is `email`; the email must be the one the current
code went to). `200 { state: "confirmed", orderRef, dropTitle, variantName, qty, amountCents,
merchant{name, paynow?, fulfilmentNote?, logoUrl?, colour?, theme?} }`. Idempotent: a retry returns the same order. Errors:
`OTP_INVALID`, `OTP_LOCKED`, `LIMIT_REACHED` (the hold is released), `HOLD_EXPIRED`, `INVALID_STATE` (cancelled),
`VALIDATION`. A Closed drop still accepts confirms for holds that have not expired.

## Merchant API (`{apiUrl}/m/...`, Cognito access token)

`Authorization: Bearer <access token>` from managed login (code + PKCE). The tenant is the token's `sub`; every
key is scoped to it, so another merchant's drop is `NOT_FOUND`.

| Route | Body | Returns |
| --- | --- | --- |
| `GET /m/profile` | | `MerchantProfile` or `null` |
| `PUT /m/profile` | `{ name?, slug?, logoUrl?, coverUrl?, colour?, theme?, tagline?, paynow?, fulfilmentNote? }` | profile; see profile rules |
| `GET /m/slugs/{slug}` | | `{ slug, available, problem }`; `available` is true when the link is free or already yours |
| `POST /m/uploads` | `{ image: base64 or data URL }` | `201 { path: "/b/{tenantId}/{hash}.{ext}", contentType, bytes }` |
| `GET /m/drops` | | `Drop[]`, newest first |
| `POST /m/drops` | drop fields (below) | `201 Drop` (Draft) |
| `GET /m/drops/{dropId}` | | `Drop` |
| `PATCH /m/drops/{dropId}` | any drop fields | `Drop`; see editing rules |
| `DELETE /m/drops/{dropId}` | | `204`; drafts only |
| `POST /m/drops/{dropId}/schedule` | | `Drop` (Scheduled); writes shards, `drop.json`, `state.json`, open schedule |
| `POST /m/drops/{dropId}/unschedule` | | `Drop` (Draft); before the entry window only |
| `POST /m/drops/{dropId}/cancel` | | `Drop` (Cancelled); from Scheduled or Live |
| `POST /m/drops/{dropId}/duplicate` | | `201 Drop` (Draft copy) |
| `GET /m/drops/{dropId}/live` | | `{ state, variants[{id, name, stock, out}], activeHolds, orders, unitsOrdered, queue{earlyCount, lateTickets} }` |
| `GET /m/drops/{dropId}/orders` | | `Order[]`, oldest first |
| `PATCH /m/orders/{ref}` | `{ dropId, status: "confirmed" \| "paid" \| "no-show" }` | `Order` |
| `GET /m/drops/{dropId}/export.csv` | | CSV: `ref,name,email,variant,qty,unit_price_sgd,amount_sgd,status,ordered_at` |
| `GET /m/drops/{dropId}/report` | | `{ stock, orders, units{ordered, paid, unpaid, noShow}, revenueCents{ordered, paid, outstanding}, sellThrough, firstOrderAt, soldOutAt, secondsToSellOut, byVariant[], queue }` |

Profile rules (`validateProfileInput`): a merge, so a field left out keeps its value and `null` (or `""`) clears it;
`tier` is never taken from the body. `name` 1–80; `slug` 3–40 of `a-z 0-9 -`, starting and ending with a letter or
digit, not reserved (`admin`, `api`, `m`, `d`, `s`, `b`, …), unique across shops (`SLUG_TAKEN`); `colour` `#rrggbb`
(stored lowercase); `theme` light | dark | auto (auto); `tagline` ≤ 140; `logoUrl` and `coverUrl` must be images this
merchant uploaded (`/b/{tenantId}/…`); `paynow` ≤ 40; `fulfilmentNote` ≤ 300. A save republishes `drop.json` for the
shop's Scheduled and Live drops and rewrites `shop.json` (deleting the old one when the slug moves); pages pick it up
within about a minute.

Uploads: PNG, JPEG or WebP, checked from the bytes (never SVG or GIF), at most 1 MiB decoded. The console shrinks
images in the browser first. 100 uploads per merchant per day (`RATE_LIMITED`).

Drop fields and limits (`services/merchant-api/src/validate.ts`): `title` 1–120 (required), `description` ≤ 2000,
`imageUrl` (an image this merchant uploaded, a legacy `https://` link, or `null` to remove it), `variants` 1–10 of `{ id?, name 1–60, stock 1–10000, priceCents 0–10000000 }` (required), `openAt`,
`endAt` (required; at most 24 h apart), `entryWindowMin` 0–60 (15), `graceSec` 0–120 (30), `perBuyerLimit` 1–10 (2),
`holdSec` 120–900 (300), `admitWindowSec` 30–600 (120), `ratePreset` gentle | normal | fast (normal),
`verification` off | email (email), `shardCount` 1–16 (4).

Editing rules: Draft, anything. Scheduled before the entry window: anything except `openAt`, `entryWindowMin`,
`variants`, `shardCount` (unschedule to change those). From the entry window on: only `title`, `description`,
`imageUrl`. Live, Closed, Cancelled: nothing. Scheduling needs the entry window at least 3 minutes away (the open
fires 90 s ahead of it).

`live` reads stock counters, so it shows units held or sold right now. `orders`, `export.csv` and `report` count
orders only: after close, unswept holds keep counters high (docs/degradation.md).

## Controller (EventBridge Scheduler → Lambda)

| Event | When | Does |
| --- | --- | --- |
| `{ action: "open", tenantId, dropId }` | one-off, 90 s before `entryOpensAt` | Scheduled → Live, rebuilds `shop.json`, creates `tick-{dropId}` (rate 1 min), then ticks |
| `{ action: "tick", tenantId, dropId }` | every minute while Live | ~55 s loop, a tick every 2.5 s: freeze early group, publish watermark and sold-out flags, sweep expired holds, close at `endAt` or when sold and settled; finish Closed / Cancelled drops (which also rebuilds `shop.json`) |

Log lines worth querying in CloudWatch Logs Insights: `metric: "ticket"` (arrival, r or n, block, instance),
`metric: "claim"`, `metric: "order"`, and controller `msg: "opened"` (`lagMs`), `"early group frozen"`,
`"expired holds released"`, `"drop closed"`, `"holds voided on cancel"`.
