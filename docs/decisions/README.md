# Decision log

One file per decision: context, decision, options rejected, consequences, and what changed from the preliminary report. This becomes the final report's "changes from the preliminary design" section.

| # | Decision | Date |
| --- | --- | --- |
| 0001 | [Buyers verify by email code at checkout, not at the queue](0001-buyer-verification-at-checkout.md) | 2026-10-05 |
| 0002 | [Codes are sent with Amazon SES from our own domain, with our own OTP logic](0002-email-delivery-ses.md) | 2026-10-05 |
| 0003 | [Pre-open entry window with a random draw, then first-come; admission is a pure function of time](0003-pre-open-random-draw.md) | 2026-10-05 |
| 0004 | [Payment is delegated through a PayNow handoff; merchants mark orders paid or no-show](0004-payment-paynow-handoff.md) | 2026-10-05 |
| 0005 | [A drop has variants; a claim takes one variant](0005-variants-one-per-claim.md) | 2026-10-05 |
| 0006 | [One on-demand table, tenant first in every key, tickets not stored](0006-single-table-design.md) | 2026-10-05 |
| 0007 | [Growth is priced by buyer sessions, not 1% of drop value](0007-pricing-session-based.md) | 2026-10-05 |
| 0008 | [GitHub with Actions and OIDC; personal dev accounts plus one shared evaluation account](0008-repo-ci-accounts.md) | 2026-10-05 |
| 0009 | [Next.js static export with one generic drop page](0009-front-end-static-export.md) | 2026-10-05 |
| 0010 | [Simon builds the initial end-to-end path; Liwen and Fung Wei review and then take over](0010-team-and-handover.md) | 2026-10-05 |
| 0011 | [Cohort drop on Fri 30 Oct, backup Fri 6 Nov](0011-cohort-drop-date.md) | 2026-10-05 |
| 0012 | [Mobile-first UI with Tailwind and shadcn/ui; each shop brands its pages](0012-ui-refresh-and-shop-branding.md) | 2026-10-06 |
| 0013 | [Operators, usage metering and plan limits](0013-operators-metering-plans.md) | 2026-10-07 |
| 0014 | [Buyers' order data is deleted 180 days after the drop](0014-buyer-data-retention.md) | 2026-10-07 |

To add one: copy the newest file, bump the number, keep it under a page.
