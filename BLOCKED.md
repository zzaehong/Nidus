# Current blocker — multi-provider validation, 2026-10-08

Previous Copilot model gateway slice remains VERIFIED and its evidence is preserved.
Current Gemini/NVIDIA single-provider acceptance is BLOCKED: selected models returned
HTTP 404 (Gemini newest candidate: 400) despite source=api catalogs and valid=true
connection tests. See MODEL_PROVIDER_VALIDATION_REPORT.md and per-provider evidence.
Provider error bodies/credentials were not read; root cause is not asserted.

Gateway fallback IS VERIFIED with explicit local 503 fault injection and actual
NVIDIA 429 → actual Copilot response → Completed/Archive. Two injected failures also
complete through Copilot. Injected 401 blocks without downstream calls. This does
not prove standalone Gemini/NVIDIA generation success or a genuine upstream outage.

No billing/security/account credential changes were made. Temporary restricted
inference keys were deleted; existing keys and baseline evidence remain intact.
Needed: an exact Gemini and NVIDIA model that succeeds in the existing OmniRoute
account, then rerun each synthetic-only policy with a new evidence filename.
Do not paste secrets or enable new payments to bypass the blocker.
