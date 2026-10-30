# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `patronage/launch`. Use the `gh` CLI.

The repo is public, so issues, comments and PRs follow the same rule as code: no client names, hostnames, ids, content, screenshots or credentials (see [AGENTS.md](../../AGENTS.md)).

## Conventions

- **Create an issue**: `gh issue create --repo patronage/launch --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo patronage/launch --comments`.
- **List issues**: `gh issue list --repo patronage/launch --state open --json number,title,body,labels,comments` with `--label` and `--state` filters as needed.
- **Comment on an issue**: `gh issue comment <number> --repo patronage/launch --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --repo patronage/launch --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <number> --repo patronage/launch --comment "..."`, only when asked or when the workflow closes a child issue.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if external PRs should be triaged as feature requests; `/triage` reads this flag.)_

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: try `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `patronage/launch`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo patronage/launch --comments`.

## Spikes

A spike is an issue whose findings land in `docs/spikes/<issue-number>-<slug>.md` (see [docs/spikes/README.md](../spikes/README.md)). When a spike settles a decision the rest of the repo must follow, also record it as an ADR in `docs/adr/`.
