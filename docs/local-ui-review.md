# Local UI and workflow review

Branch: `feat/dropdeck-ui-workflow`. Implements the approved Bold app-like direction using the existing Figtree/Bricolage design system and buyer components.

## Run

```sh
pnpm install
pnpm dev:demo
```

Open http://localhost:3000/__preview/. The merchant console is at `/m/`, branding at `/m/?view=shop`, and the gallery links to each buyer state. The banner identifies all simulated pages. Checkout code: **123456**. No email, purchase, payment or AWS write occurs in this mode. Use the gallery's reset button to restore fixtures. Stop the server with Ctrl-C.

`pnpm dev` retains the ordinary connected environment and needs a deployed `public/config.json`. Development rewrites now support buyer and shop deep links. Production remains a static export.

## Implemented

- Populated merchant list, summary tiles, reserved-stock progress and paid/awaiting order counts; mobile cards and desktop table.
- Bounded authenticated `/m/overview?ids=...`: at most 20 unique drop IDs, four concurrent drops, one projected page of 500 orders per drop. Counts are marked partial when DynamoDB has another page. The browser requests one snapshot and offers refresh rather than polling full order lists for every row. Stock counters represent held plus confirmed units while live; ended summaries count orders.
- Draft “Finish & schedule” action opens the editor. Preview uses current form fields with the same title, image, countdown, rule and item components as the public page.
- Full branding preview with the current colour/theme and a real drop; collapsible on phones and sticky on desktop.
- Unsaved-change protection for editor/branding navigation and tab close.
- Checkout reload uses the hold endpoint to restore masked recipient, resend cooldown, send/attempt limits and confirmed/expired state. It never exposes the OTP hash or unmasked email.
- Active checkout can finish after a drop closes. Cancellation preserves confirmed references and replaces payment instructions with contact-the-shop guidance.
- Reservation wording distinguishes unconfirmed holds from unpaid confirmed orders. Queue metrics are labeled tickets issued, an upper bound including already admitted buyers.
- Retry controls and delayed/offline state without discarding a saved buyer place. Admission countdown is an estimate; the server decides whether a claim is still valid.
- Development scenarios cover countdown, entry, draw, queued, admitted, held, code sent, confirmation, all reserved, hold/turn expiry, closed, cancelled, missing, delayed updates, closed-with-hold, cancelled-with-order, and teal/dark and yellow/light branding.

## Validation on 11 October 2026

- Workspace TypeScript checks passed.
- 116 unit/infrastructure tests passed across the affected packages and workspace suite.
- All 38 DynamoDB Local integration tests passed with Docker, including checkout-resume assertions and merchant overview tenant isolation.
- Static production build passed with `DROPDECK_DEMO=1`; `pnpm web:verify-production` confirmed no preview route or fixture/auth markers in the export.
- Browser checks: countdown at 320/390 px, merchant layout at 768/1440 px, storefront live/upcoming/past sections, mobile reservation → code send → refresh → confirmation, draft preview using unsaved title, draft save and populated dashboard, desktop branding preview.
- The unsaved-navigation prompt was observed. Automated dismissal was interrupted by the browser, so the stay-on-page branch, full keyboard/200% zoom/reduced-motion matrix and all scenario combinations still need manual acceptance review.
- Chrome's Grammarly extension injected attributes into `<body>` before hydration. The layout now tolerates that root-level difference; refreshed Chrome and in-app previews showed no new hydration errors.

## External acceptance checks

The frontend is locally runnable; demo services intentionally simulate backend behavior. This does not validate Cognito login, SES delivery, CloudFront caching, deployed IAM or scheduled controller execution. Those require deploying this branch to a development AWS environment, which has not been done. The new overview route and hold-resume metadata must be deployed with the frontend before connected testing.

Keep the approved deferred scope deferred: SMS/accounts/cross-device recovery, mixed baskets, automated payments/refunds, receipt emails, pagination and anti-bot controls.
