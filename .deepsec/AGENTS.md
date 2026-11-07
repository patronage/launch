# DeepSec workspace

Read [README.md](README.md) before changing or operating this workspace. Use `pnpm security:scan [commit]` from the repository root for candidate discovery. Model-backed processing is disabled because the subscription proxy does not enforce its TLS upstream-name boundary; only `security:subscription stop <run-directory>` remains available for cleanup. Do not bypass this guard, run agent-backed DeepSec commands against the live checkout or reuse host agent sessions.

Keep configuration and INFO.md credential-free. Keep runs, findings, source snapshots and provider state ignored. Candidate counts are not vulnerabilities or evidence of a clean review. Run `pnpm security:test` after boundary changes.
