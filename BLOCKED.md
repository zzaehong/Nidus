# Remaining hypothesis decision

The offline runtime is implemented and verified. The original mission's stronger
hypothesis—an actual generative AI Employee planning and doing work—is not yet
validated. No model runtime, model adapter, credentials or provider configuration
exists in the repository. `ollama` and `llama-cli` are absent from PATH.

Do not silently reinterpret deterministic extraction as AI judgment. Choosing a
real provider also establishes a new network/data-transmission/Secret boundary;
the prompt explicitly requires stopping for security-model or approval-policy
changes and forbids arbitrary paid services or external data transmission.

Required human decision for the next slice: choose a local model host or an
explicitly authorized external provider, including allowed data and credential
handling. No API key should be pasted into task context or committed to Vault.
Current work is safely committed in local feature/integration branches. No model
service was created, no data transmitted, no concept document changed.
