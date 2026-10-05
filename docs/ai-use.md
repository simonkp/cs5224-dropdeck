# AI-use log

Running log for the final report's AI-use declaration (required, and counted in the page limit).
Add a line whenever an AI tool shapes code, design or text. Keep it honest and short.

| Date | Who | Tool | Where it was used | What we kept / changed | What we learned |
| --- | --- | --- | --- | --- | --- |
| 2026-09-29 | Team | Claude | Workflow alignment draft (buyer OTP before queue) | Rejected OTP-at-queue after review: cost scaled with crowd (~US$545/drop) | Check every per-user cost against the reference workload before adopting it |
| 2026-10-05 | Simon | Claude | Build plan, decision log seed, repo scaffold (shared libs, merchant API, CDK stack, CI) | Reviewed; decisions confirmed in an interview before writing | Pure functions for admission make the claim check stateless and testable |
| 2026-10-05 | Simon | Claude Code | GitHub repo + SSH setup; phased build plan; CI deploy gating; CDK account allowlist | Kept; the allowlist caught synth resolving to an unrelated local [default] AWS account | The CDK CLI overrides CDK_DEFAULT_ACCOUNT from whatever credentials are active, so guard by account ID, not by env var |
