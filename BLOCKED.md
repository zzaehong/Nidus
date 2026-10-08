# Provider activation blocker status — 2026-10-08

**RESOLVED.** Gemini gemini-3.5-flash-lite and NVIDIA Hosted NIM
nvidia/nemotron-3.5-lightning-30b-a3b each completed a real synthetic Nidus Task
through scoped approval, all six verification checks, and Archive (Active 0 / Archive 1).
See PROVIDER_ACTIVATION_REPORT.md and model-live-*-success.json evidence.

Old 400/404 failures and Copilot/Fallback evidence remain unchanged. The retired or
inaccessible reason for all prior candidates is not assumed. Latest Gemini Flash
400 was traced to the router's active-catalog gate; Flash-Lite works. NVIDIA Lightning
normal completion required more than the initial 128-token probe allowance.
A Gemma candidate timed out and was not activated.

Validated pool policy and scoped credential are usable outside the Repository.
No new billing/subscription/account security changes. Costs/quotas remain unknown.
No remaining mission blocker; transient availability and general semantic verification
limits are documented in PROVIDER_ACTIVATION_REPORT.md.
