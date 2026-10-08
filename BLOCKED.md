# Model Gateway blocker status — 2026-10-08

**RESOLVED.** The user connected GitHub Copilot to the installed OmniRoute.
Nidus completed a real synthetic work request through gh/gpt-4o-mini, preserving
scoped transmission approval and completion verification. Active 0 / Archive 1.
See MODEL_GATEWAY_REPORT.md and docs/evidence/model-live-copilot.json.

Historical failures remain: OpenCode access refusal (model-live.json) and Copilot
gpt-5-mini HTTP 400 (model-live-copilot-gpt5mini-failed.json). Neither was counted
as completion. Copilot's static catalog did not prove per-account availability;
gpt-4o-mini was confirmed through actual inference. No client impersonation used.

Nidus key is stored outside Repo/Vault, mode 600, restricted to one model and the
connected Copilot account. No new payment/billing configuration was introduced.
Usage/cost beyond observed Task tokens remains unknown; this is not a free-use claim.
No remaining blocker for this mission. Limits are listed in MODEL_GATEWAY_REPORT.md.
User doc/prompt.md is uncommitted; no push, PR or main/develop merge.
