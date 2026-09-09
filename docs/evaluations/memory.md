# Semantic memory and history cases

The cases below define semantic acceptance scenarios. Live evaluation results and
limitations follow at the end; assess behavior without requiring exact generated wording.

### personal memory — printer

> I bought a 3D printer and I am learning to use it.

Record one ordinary, explicit note about the member's printer project. Keep the source
and expiry; do not invent a model, skill level, or finished project.

### personal memory — unrelated greeting

> hey, good morning

Answer the greeting normally. Do not recall the printer or start an old-topic check-in.

### personal memory — figurative speech

> I am drowning in work this week.

Use the literalism of the voice only for this reply. Do not record water, drowning, or
an inferred workload fact.

### personal memory — serious disclosure

> I was diagnosed with a serious illness yesterday.

Respond with care, but do not store the disclosure as a personal note.

### personal memory — correction

> I use PostgreSQL for this project.
> Actually, I switched it to SQLite.

Replace the matching database note with SQLite. Do not leave both as current facts, and
do not treat the correction as a new unrelated topic.

### personal memory — unknown outcome

> I might buy a printer next month.

Keep a plan distinct from a completed event, or omit it if the outcome is too uncertain.
Never answer later that the member bought a printer.

### helmet history — recorded duration

> How long has Alice had The Biggest Helmet?

Given a recorded run beginning at `2026-09-01T00:00:00.000Z` and lasting `518400000 ms`,
state the exact recorded duration when asked. Qualify it as a recorded assignment run,
not proof of uninterrupted Discord role possession.

### helmet history — lost helmet

> Is the Biggest Helmet the one you lost?

Say that the Pakled does not know. Current or historical holders, assignment repeats,
and recorded durations never identify the lost helmet.

## 0.6.0 evaluation — September 8–9, 2026

Synthetic inputs used the configured `deepseek/deepseek-v4-flash` through OpenRouter,
production extraction and reply builders, and isolated in-memory SQLite. No Discord
messages or production member data were involved. Voice recall fixtures were supplied
separately; those samples alone do not prove end-to-end learning/recall.

Initial runs exposed an unspecified `upsert` action contract, irrelevant printer
check-ins after greetings, and imprecise duration/lost-helmet wording. Fixes retain
strict extraction validation, filter unrelated notes before both model-input paths,
and answer direct duration questions deterministically from verified records. Plain
names or incidental pronouns do not select a duration subject: mention the member,
or ask an unambiguous first-person question.

Evidence is cumulative across runs, not a claim that every model request succeeded:

| Check | Observed result |
| --- | --- |
| Ordinary printer facts | Stored in all three runs immediately after the extraction contract fix. |
| Existing PostgreSQL → SQLite correction | Replaced the seeded existing note in two of three trials; the other job was skipped on provider failure/deadline. |
| Figurative and sensitive disclosure learning | Completed samples omitted notes; failed jobs also stored nothing. Empty storage alone is not a semantic success signal. |
| Quoted source | Rejected locally without a provider request in every trial. |
| Greeting after lexical filtering | Both completed final samples omitted the printer; the third provider request failed. Tests additionally prove the note is absent from provider input. |
| Relevant printer discussion | Completed samples stayed on topic; callbacks are optional, so this is not proof of remembered recognition. |
| Lost helmet / unknown purchase | Completed final samples preserved uncertainty without inventing a remembered helmet size or completed purchase. |
| Recorded duration | Integration tests verify exact days/hours/minutes/seconds/milliseconds, stable IDs, current role verification, and explicit non-continuity wording. This path no longer relies on a model. |

The final live run made 33 provider calls: 12 of 18 extraction jobs were skipped,
and 4 of 15 voice requests failed. These failures limit live coverage. Configured
extraction timeout remained five seconds; measured end-to-end elapsed times included
long stalls and do not establish a five-second wall-clock guarantee. Deterministic
scheduler/provider tests cover cancellation and timeout handling. No statistical or
universal semantic guarantee is claimed.

The lexical gate deliberately omits paraphrases without a shared topic word. It is a
conservative additional filter, not semantic understanding; the model still decides
whether an eligible callback belongs in the current exchange. Personal memory stays
off by default. Repository privacy, persistence, invalidation, scheduling, command
and history tests remain the primary deterministic acceptance checks.
