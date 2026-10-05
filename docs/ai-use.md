# AI-use log

Running log for the final report's AI-use declaration (required, and counted in the page limit).
Add a line whenever an AI tool shapes code, design or text. Keep it honest and short.

| Date | Who | Tool | Where it was used | What we kept / changed | What we learned |
| --- | --- | --- | --- | --- | --- |
| 2026-09-29 | Team | Claude | Workflow alignment draft (buyer OTP before queue) | Rejected OTP-at-queue after review: cost scaled with crowd (~US$545/drop) | Check every per-user cost against the reference workload before adopting it |
| 2026-10-05 | Simon | Claude | Build plan, decision log seed, repo scaffold (shared libs, merchant API, CDK stack, CI) | Reviewed; decisions confirmed in an interview before writing | Pure functions for admission make the claim check stateless and testable |
| 2026-10-05 | Simon | Claude Code | GitHub repo + SSH setup; phased build plan; CI deploy gating; CDK account allowlist | Kept; the allowlist caught synth resolving to an unrelated local [default] AWS account | The CDK CLI overrides CDK_DEFAULT_ACCOUNT from whatever credentials are active, so guard by account ID, not by env var |
| 2026-10-05 | Simon | Claude Code | Phase 1: console sign-in (managed login + PKCE), drop editor, schedule rollback, initial state.json, signing-key wiring | Kept; chose flip-state-first for /schedule so a concurrent loser cannot roll back the winner; kept drop.json on cancel so buyers see "cancelled" | A Scheduled drop's state.json is written once, so the page clock must come from the Date + Age headers, not the body |
| 2026-10-05 | Simon | Claude Code | Phase 2: ticket/claim/checkout/controller, DynamoDB Local integration tests, buyer page, oversell eval script | Kept; changed the claim to reserve before writing the hold (a crash then undersells instead of oversells) and rewrote `sold + q <= capacity` as `sold <= capacity - q` (conditions cannot do arithmetic) | Integration tests against a real engine caught a block-refill race that unit mocks would not; a deliberately broken guard confirmed the oversell tests fail |
| 2026-10-05 | Simon | Claude Code | Phase 3: hold sweep, sold-out flags, close, cancel handling; degradation policy | Kept; added an "only if expired" condition to the sweep release so a stale index read cannot take a live hold | Breaking each guard on purpose showed which tests actually protect it; one guard had no test until then |
