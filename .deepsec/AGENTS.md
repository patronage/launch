# DeepSec workspace

Read [README.md](README.md) before changing or operating this workspace, and [Handling security findings](../docs/agents/security-findings.md) before sharing results or publishing remediation. Use `pnpm security:scan [commit]` from the repository root for candidate discovery. There is no model-backed runner; do not add one without an independently verified egress boundary, run agent-backed DeepSec commands against the live checkout or reuse host agent sessions.

Keep configuration and INFO.md credential-free. Keep runs, findings, source snapshots and provider state ignored. Candidate counts are not vulnerabilities or evidence of a clean review. Run `pnpm security:test` after boundary changes.
