# Model Gateway live acceptance blocker — 2026-10-08

The revised prompt explicitly authorizes designing and implementing an external
model boundary; the previous architecture/permission decision blocker is resolved.
Gateway, Runtime permission, candidate verification, routing and observability are
implemented and pass offline/loopback tests.

Remaining blocker: no legitimately accessible generative model route is configured.
The real synthetic Live Acceptance call to OpenCode Zen `big-pickle` returned an
authentication/access refusal, safely persisted as Blocked with no completion.
See docs/evidence/model-live.json. The first adapter mapped both 401 and 403 to
`authentication_failed`; subsequent hardening preserves the HTTP status and
separately names 403 `access_denied`. The initial evidence is not rewritten.

OmniRoute's published source documents OpenCode's client-specific free-tier gate:
https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.52/open-sse/executors/opencodeFreeTierContract.ts
Nidus does not impersonate that client or attempt to bypass the restriction.
Provider documentation: https://opencode.ai/docs/zen/ . Free model availability
alone is not evidence that a generic keyless API client is authorized.

Before installation, named model credential environment variables were absent;
no credential values were inspected or printed. User then explicitly requested
OmniRoute installation. Installed npm 3.8.51 and started a loopback daemon on
20128; dashboard responds 200 and the unauthenticated model API responds 401.
Default Nidus policy now points there. A legitimate free Provider/Combo and
Endpoint Key configuration remain necessary. See OMNIROUTE_INSTALL_REPORT.md.

Needed: a normal authorized compatible API/router endpoint and model, with its
credential provided through the named environment variable if required. No Key
should be pasted in chat, committed or stored in a Vault. Configure the process
launch environment or run the live command yourself from a shell with that env.
Do not create a paid account, add billing details or introduce automatic paid
fallback just to finish this test. Existing provider credentials may still be
subject to its normal usage limits; only explicitly authorized free routes should
be used for the next acceptance attempt.

The Live acceptance itself remains unaccepted. Its harness and failed evidence
are preserved separately from successful model completion. Verified design/core/hardening features are locally integrated into
feat/model-gateway. User's edited doc/prompt.md remains untouched and uncommitted.
No push, PR or main/develop merge was performed.
