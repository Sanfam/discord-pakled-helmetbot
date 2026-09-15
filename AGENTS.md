# discord-pakled-helmetbot

A Discord bot that periodically redistributes a set of "helmet" roles among server members,
themed as a Pakled leader who has lost the Biggest Helmet and cannot remember what it looked like.

See [docs/proposal/](docs/proposal/) for the project specification and [docs/personas/](docs/personas/)
for the Pakled voice specification.

## Working agreements

Before a round of work is considered complete, request a **Codex Review** (adversarial where the
work touches failure paths, money, state, or anything hard to reverse). Treat its findings as
recommendations: act on them unless they are out of scope or ask for unnecessary validation, and
say plainly which were rejected and why. Review comes before the commit, not after.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `Sanfam/discord-pakled-helmetbot`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

`docs/proposal/` and `docs/personas/` are origination artifacts: read them, don't amend them. Where a decision has moved on from what they say, `CONTEXT.md` and the ADRs are authoritative.

<!-- BEGIN CODEX ORCHESTRATION — to remove, delete this block and the four agent files it names -->
## Codex orchestration

These instructions apply only to Codex. Sol is the default parent; use Astra as the parent only
when the user explicitly requests it. The active parent owns scope, architecture, decomposition,
integration, review, and final acceptance.

Delegate only when a bounded worker saves time or parent context:

- Handle small, cross-cutting, or unresolved work in the parent.
- Use `spark-worker` for tiny, deterministic edits when available; otherwise use `luna-worker`.
- Use `luna-worker` for normal bounded implementation.
- Use `sol-escalation` for difficult bounded work under an Astra parent when Luna is insufficient.
  When Sol is the parent, handle harder work directly instead of recreating the parent in a worker.
- Use `codex-reviewer` for the required fresh-context Codex Review.

Before delegating, resolve consequential product and architecture choices. Give each worker one
outcome, the minimum sufficient context, its allowed scope, constraints, completion criteria, and
useful verification. Parallelize only independent work, and never assign overlapping write scopes.
The parent reviews every returned diff and its evidence. A worker's self-verification does not
replace the required pre-commit Codex Review above.
<!-- END CODEX ORCHESTRATION -->
