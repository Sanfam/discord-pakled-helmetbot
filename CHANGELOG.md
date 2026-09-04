# Changelog

## v0.2.0 — Grunk Is Thinking

The bot was already silent in five different ways and could not tell you which one
it was doing. This release is about being able to answer "why did it not reply?"
without guessing.

### Saying why it stayed quiet

A mention can be declined for four separate reasons — the channel is denied, the
question was empty once the mention was stripped, the user is inside the mention
cooldown, or the channel is. All four returned `null` and logged nothing, which
made an ignored mention indistinguishable from a dead process. Each now reports
its reason at debug level, and a mention that arrives at all is logged the moment
it is recognised: if a mention is never logged, it never reached the bot.

### Watching the gateway

There was no connection logging whatsoever. A shard disconnect is now a warning
with its close code, and a resume is logged with `replayedEvents` — the number
that says whether messages were replayed or quietly lost. Messages sent during a
gateway gap are never delivered, so this is usually the real answer when the bot
appears to ignore someone.

### A swallowed send is no longer silent

`sendTo` caught every failure and returned `false` with no explanation, so the bot
could decide to speak, fail to speak, and log nothing about it. It now reports the
reason, wired up for both unprompted speech and Ceremony beats.

The passive cycle's remaining silent exits — no speakable channel, no provider, a
channel that vanished, an unreadable history — say so too.

### Grunk is typing

The Pakled shows a typing indicator while a model is composing its reply, refreshed
under Discord's ten-second expiry so a slow model does not appear to have wandered
off. It starts only once every gate has passed, so the bot never appears to be
typing an answer it has already decided not to give.

### PAKLED_LOG_LEVEL

Overrides `logging.level` from the environment. Turning on debug to watch a live
problem is now a restart of the container rather than an edit to the config file it
mounts. An unrecognised value fails at startup rather than quietly logging at the
wrong level.

## v0.1.0 — The Great Helmet Barrel

First release. The bot runs unattended, redistributes helmets on its own schedule,
and talks.

### The Ceremony

Ten ranked helmet roles, from A Tiny Helmet up to The Biggest Helmet, provisioned
and maintained by the bot. Every 3–14 days — randomised, never a cron — it takes
them all back, puts them in the Great Helmet Barrel, and hands them out again.

The Ceremony is **performed, not executed**: five beats spoken in character across
5–15 minutes, with the roles visibly changing between them. The application decides
what happened and supplies only the facts; the model supplies the words.

- **One invariant holds absolutely.** Exactly one member holds The Biggest Helmet
  after every successful Ceremony, verified against Discord afterwards rather than
  assumed from the pairing.
- **The Pakled is in its own draw** ([ADR-0001](docs/adr/0001-the-pakled-is-a-helmet-holder.md)),
  guaranteed a helmet but never told which. It can draw The Biggest Helmet and
  remain suspicious of it, which is the entire joke.
- **Fewer people than helmets is normal**, not an error. The remainder stay in the
  barrel and get remarked upon.
- **Recently active members are likelier to be drawn**, so a dormant member does not
  anchor a helmet for a fortnight without noticing. Weighted, never filtered —
  nobody is ever permanently excluded.
- **Rollback is real.** Discord role changes are not a transaction, so applying one
  performs a compensating transaction: every mutation is logged as it lands, and a
  failure replays that log backwards. It attempts every remaining compensation even
  after one fails.

### The Multihat

Rarely and deliberately, one Ceremony gives a single member **two helmets at once**.
The Pakled treats them with something close to reverence until the next Ceremony:
deferring to them, taking their side, mentioning the two helmets. It never explains
the rule and never announces it as an event.

It costs a Helmet Holder — ten helmets across nine people — which is the point.

### Conversation

- **Answers when mentioned**, with roughly twenty recent messages as context.
- **Occasionally speaks unprompted**, but only above an activity floor: several
  recent messages from more than one person. A quiet server costs nothing and stays
  quiet, because no model is consulted below the floor.
- **One Active Channel at a time**, weighted toward conversation and away from
  wherever it last spoke, so it wanders instead of settling.
- **Silence is a valid outcome** and usually the right one.

The character lives in [prompts/pakled-conversation.md](prompts/pakled-conversation.md)
— 368 lines, loaded at startup, revisable without a code change. It carries the
Pakled voice from the persona specification plus this particular Pakled's situation:
the lost helmet, the barrel it is proud of, the reasoning it never notices is
circular.

Including **selfish literalism**. Asked how much wood a woodchuck would chuck, it
does not offer to measure the wood:

> A woodchuck is a small animal. It could not carry much wood. We should find out
> who has the wood. They might give it to us.

### Commands

| | |
| --- | --- |
| `/helmet status` | what is happening with the helmets |
| `/helmet next` | when the next Ceremony is due |
| `/helmet roles` | who has which helmet |
| `/helmet pause` | stop running Ceremonies *(Manage Server)* |
| `/helmet resume` | resume, and clear any circuit breaker *(Manage Server)* |

Holders are reported from what Discord actually shows, not only from what the
database remembers, so a hand-moved role is not reported back confidently and
wrongly.

### Operating it

- **Docker-first**, multi-arch (`linux/amd64` and `linux/arm64`), published to GHCR
  on tagged releases.
- **One mounted directory** holds `config.yaml` and `bot.sqlite`. Configuration is
  read-only input; the database is the only writer of state.
- **Secrets from the environment.** `OPENROUTER_API_KEY` is optional — without it
  the bot still runs Ceremonies and speaks in static fallback lines. Losing the
  character beats losing the bot.
- **The schedule survives restarts.** A redeploy resumes the existing timestamp
  rather than firing a Ceremony.
- **Shutdown waits** for a Ceremony in progress, but not forever; one interrupted
  anyway is recovered on the next start rather than blocking every later Ceremony.
- **A circuit breaker** stops Ceremonies after three consecutive failures and says
  so in the admin channel, rather than retrying into the void.

Set `development.dryRun` to preview a Ceremony without changing a single role.

### Deliberately not in this release

Multi-guild runtime (the schema is ready;
[ADR-0002](docs/adr/0002-guild-scoped-schema-single-guild-runtime.md)), persistent
character memory, helmet history, and the cosmetic commands. Audit-grade
traceability is also out — this is a for-fun role swapper, and nothing bad happens
if a Ceremony does something odd.

### Notes for operators

Two things need doing by hand before it works:

1. Enable **both** privileged intents in the Discord Developer Portal — Server
   Members and Message Content. The gateway refuses the connection without them.
2. Move the bot's role **above** where the helmets sit. Discord will not let it
   manage a role at or above its own position, and members whose own highest role
   outranks the bot cannot receive helmets at all.

Editing `config.yaml` is a destructive operation: removing a helmet deletes its
Discord role and strips it from whoever holds it
([ADR-0003](docs/adr/0003-bot-garbage-collects-its-own-helmet-roles.md)). This is
deliberate — the bot owns its roles and cleans up after itself — but a typo has
consequences.

The model is a configuration string. The request is deliberately the cheapest,
plainest one that still sounds right: reasoning disabled, no tools, routed by price.
Reasoning models actively broke the character — their preamble defeats the response
contract and their thinking tokens exhaust the budget, leaving the bot emitting
fallback lines while looking perfectly in character.
