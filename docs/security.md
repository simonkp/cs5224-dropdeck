# Security and personal data

A one-page threat model: what we protect, from whom, how, and what we have chosen to accept. Reviewed 2026-10-07; update it when the architecture changes.

## What we protect

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Buyers' names and emails (orders) | DynamoDB `ORDER#` items, holds | Personal data under PDPA |
| Fairness of a drop | Signed ticket and hold tokens; the random draw | The product's promise |
| Stock counts | Sharded DynamoDB counters, conditional writes | Overselling is the failure we exist to prevent |
| Merchant accounts | Cognito user pool | A taken-over account can cancel drops and read orders |
| The site itself | S3 behind CloudFront | Defacement, or script injected into the console |
| The AWS bill | Every per-request service | Denial of wallet |

## Controls in place

| Threat | Control |
| --- | --- |
| Overselling under concurrency | Conditional writes on sharded counters; integration tests hammer it (decision 0005, `tests/integration`) |
| Bots and refresh races | A random draw for everyone who joins in the entry window; one order per normalised email per drop; email code at checkout (decisions 0001, 0003) |
| Forged or replayed queue positions | Ticket and hold tokens are HMAC-signed with keys in SSM SecureString, scoped to one drop or hold, and expire |
| Email code guessing and spam | Codes sent only after a reservation; 3 sends and 5 attempts per hold; stored as a keyed hash |
| One merchant reading another's data | The tenant is the Cognito token's `sub`, the first part of every key; another shop's drop is `NOT_FOUND`; uploads must be under the caller's own `b/{tenant}/` path |
| Operator actions | `/admin/*` requires the Cognito group `operators`, checked in the handler on every call; deletion is a typed-confirmation CLI |
| Malicious uploads | Type checked from the bytes (PNG, JPEG, WebP; never SVG), 1 MB cap, 100 a day per shop, content-hashed keys, served with `nosniff` |
| Script injection, clickjacking | React escapes all shop text. CSP (`frame-ancestors 'none'`, `object-src 'none'`, `connect-src` limited to our API and Cognito), `X-Frame-Options: DENY`, HSTS, `nosniff`, a strict referrer policy and a permissions policy on every page and JSON file |
| A bug overwriting the web app | Functions can write only `d/`, `s/` and `b/` in the bucket; only the deploy writes the app files |
| Account enumeration | Cognito hides whether an email has an account |
| Floods and denial of wallet | Shield Standard on CloudFront (free); polling served from the edge cache with a fixed URL; API throttle of 1,000 requests a second, with ticket floods held to their own 600 and uploads to 5; budget alarm at US$5 and US$10 |
| Losing data | Point-in-time recovery and deletion protection on the staging and prod table; the S3 bucket is retained on those stages |
| Data in transit and at rest | HTTPS only (CloudFront redirects; API Gateway is HTTPS); S3 and DynamoDB encrypted at rest |
| Vulnerable dependencies | `pnpm audit --prod` fails CI on high or critical; Dependabot opens weekly update PRs |
| Secrets in the repo | None: signing keys in SSM, deploys by GitHub OIDC (no long-lived keys), `config.json` holds only public IDs |

## Personal data (PDPA)

- **Consent and purpose:** checkout says the name and email go to the shop for this order and links to `/privacy/`. Nothing is sent while a buyer waits; details typed early stay in their browser.
- **Retention:** orders get a DynamoDB `ttl` 180 days after their drop ends and are deleted automatically (decision 0014). Holds expire a day after their window; per-email limits 30 days after the drop. The console tells merchants to export the CSV if they need longer records.
- **Deletion:** `pnpm ops -- <stage> delete-tenant <tenantId>` removes a shop's profile, drops, orders, holds, counters, usage, images, published files, shop link, schedules and sign-in.
- **Not collected:** card data (payment is PayNow to the shop), phone numbers, IP addresses in logs.

## Accepted risks and next steps

- **No WAF.** It costs money per poll and needs a second stack in us-east-1. If a drop is attacked, follow the upgrade path in `docs/cost-bom.md` (WAF on an API-only distribution, about US$6 a month).
- **`'unsafe-inline'` scripts in the CSP.** Next.js's static export inlines its bootstrap script. There is no user-supplied HTML anywhere, so the inline allowance has nothing to inject. Hashing the inline scripts at build time would remove it.
- **Uploads are served from the same origin as the console.** They are type-checked and served with nosniff, so they cannot run. A separate image domain would remove even that.
- **TLS policy.** The default `*.cloudfront.net` certificate fixes it. A custom domain would allow TLSv1.2_2021 only.
- **No MFA for merchants yet.** Optional TOTP is free on our Cognito plan, but managed login offers no way to enrol, so it needs a "set up authenticator" screen in the console. SMS MFA costs money per message.
- **Signing-key rotation.** It is manual: create new SSM values, deploy. Tickets and holds issued before the rotation stop verifying, so rotate between drops.
- **Extra browser sessions improve a buyer's odds in the draw, but not the number of orders.** Proof-of-work or Turnstile at ticket issue would raise that cost; not built.
