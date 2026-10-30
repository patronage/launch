# Domain docs

This repo has a single domain context. The apps and packages are several, but they share one vocabulary: every reference site renders the same demo site from the same content model.

## Before exploring, read these

- [`GLOSSARY.md`](../../GLOSSARY.md) at the repo root.
- ADRs in [`docs/adr/`](../adr/) that touch the area you are about to work in. The [catalog](../adr/README.md) has one line per record.
- Spike notes in [`docs/spikes/`](../spikes/) for the detail behind a decision.

If an issue and an ADR disagree, follow the ADR. If a file is missing, proceed silently; the `domain-modeling` skill creates or updates them when terms or decisions get resolved.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a hypothesis, a test name), use the term as `GLOSSARY.md` defines it. Don't drift to synonyms the glossary says to avoid.

If the concept you need isn't in the glossary yet, either you're inventing language the project doesn't use (reconsider) or there's a real gap (add the term).

## Flag ADR conflicts

If your work contradicts an ADR, say so explicitly instead of silently overriding it:

> _Contradicts ADR 0003 (Cloudflare config through the cf CLI and API), but worth reopening because…_

A change to a decision is a new ADR that supersedes the old one, and the old one's status line points to it.
