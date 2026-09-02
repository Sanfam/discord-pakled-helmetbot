# discord-pakled-helmetbot

A Discord bot that periodically redistributes a set of "helmet" roles among server members,
themed as a Pakled leader who has lost the Biggest Helmet and cannot remember what it looked like.

See [docs/proposal/](docs/proposal/) for the project specification and [docs/personas/](docs/personas/)
for the Pakled voice specification.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `Sanfam/discord-pakled-helmetbot`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

`docs/proposal/` and `docs/personas/` are origination artifacts: read them, don't amend them. Where a decision has moved on from what they say, `CONTEXT.md` and the ADRs are authoritative.
