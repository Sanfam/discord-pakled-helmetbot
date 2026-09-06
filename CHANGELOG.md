# Changelog

## v0.4.0 — Who May Steer

Who is allowed to point the bot at things, who is allowed to watch it work, and a
quiet sense of where everyone stands.

### Three tiers, and an owner who cannot lock themselves out

Watching is open to everyone: `/helmet status` and `/helmet roles` need nothing.
Steering — `next`, `pause`, `resume`, and the log stream — belongs to the server
owner and to whoever they appoint with `/helmet admin add @user`.

Only the owner may appoint or dismiss. An admin who can appoint admins is an admin
forever, whatever the owner later decides. Ownership is read from Discord on every
command rather than stored, because a stored copy is wrong the moment a server
changes hands, and being wrong there locks somebody out of their own server.

Steering commands answer privately. Who may steer, and who is being sent the log,
is nobody else's business.

### The log, by direct message

`/helmet debug-dm enable [recipient] [expiration]` sends the log to somebody as it
happens, so watching the bot no longer means having a shell on the host.

It always carries debug detail whatever `logging.level` is set to — turning it on
for an hour must not mean redeploying at a different level. Lines are batched into
one message every five seconds, because a debug stream produces several lines a
second and one direct message each would empty a rate limit and bury the reader. A
failure loop costs one message with a count rather than hundreds.

Only somebody who may already steer the bot can be sent it: log lines carry channel
ids, user ids and failure reasons. Delivery is proven before it is promised, so a
closed inbox fails at the command rather than silently for the next three days.
`expiration` takes `90m`, `2h`, `3d`, `1y` up to a year, defaults to an hour, and is
refused rather than guessed at when it cannot be read.

### Standing

Every speaker now reaches the model labelled with what they are wearing, and the
Pakled is told the order of the helmets and where it sits in it. From that it gives
a bigger helmet slightly more weight — a shade more patient with those above it, a
shade more instructive with those below, scaled to the distance and small
throughout.

It never announces this and it never makes the Pakled wrong: a Tiny Helmet who is
right beats The Biggest Helmet who is wrong, and it says so. Someone wearing no
helmet is neutral, neither pitied nor lorded over. The Multihat is unchanged and
remains different in kind — that is reverence; this is only weather.

### A deadline on every model request

Nothing bounded how long a request to the model could take. A connection that never
settles is worse here than one that fails: a mention holds one of the three
concurrency slots while it waits, so three hung requests stopped the bot answering
anybody at all until it was restarted, and a hung passive cycle never rescheduled
itself because the chain that re-arms it only runs when the last one finishes. Both
failure modes were silent.

Every request now carries a 30 second deadline (`llm.requestTimeoutMs`), and
shutdown no longer waits without limit on a passive cycle stuck on the network.
Found by a golden run that hung for twenty minutes on work that had taken a hundred
seconds the day before.

### Why it was not talking

The passive cycle chose a channel from everything the database had ever seen busy,
then measured the activity floor against what this process had heard in the last
half hour. On a quiet server it reliably picked a channel that was lively last week
and then refused it, which read in the logs as bad luck rather than as two different
ideas of "active". It now chooses only from channels that would clear the floor.

`passive cycle: gates declined` also said which gate, and by how much: the floor
(with the counts it wanted and the counts it got), the channel cooldown (with how
long is left), or the dice.

## v0.3.0 — The Helmet You Are Sure About

A Ceremony can now end in a way the Pakled has to live with for a day, and it gets
louder about it.

### Going without

Rarely (8% of Ceremonies), the Pakled hands out every helmet and keeps none for
itself. This is a deliberate exception to [ADR-0001](docs/adr/0001-the-pakled-is-a-helmet-holder.md)
and it lands differently from every other outcome, because there is nobody to blame:
the barrel does not make mistakes and nobody took anything from it, which leaves only
itself. It goes quieter, keeps checking its head, and always has a theory — it
forgot, it miscounted, it was holding the barrel and could not also take one out of
it. The theory changes. It never becomes somebody else's fault.

It is refused when it would leave nobody holding a helmet at all.

### The helmet it is sure about

Rarely (5%), the Pakled decides that one particular helmet, on one particular
person, is the one it lost. It is certain, it cannot say how it knows, and being
asked how it knows does not shake it.

This one is not sadness — it is a plan, and the Pakled is better with a plan. The
difficulty is that the barrel gave the helmet away fairly, so it cannot demand it
and cannot take it. It has to get them to want to hand it over, and it is bad at
this: it offers to trade things it does not have, suggests the helmet may not fit
them very well, offers to hold it somewhere safe, and proposes one small extra
ceremony for that one helmet only.

Nobody is ever actually deceived. The schemes are transparent, and no means no.

### Speaking up about it

A mood makes the bot speak unprompted more often — twice as often for going without
or for a Multihat, four times for coveting — decaying back to its normal interval
over about a day. Moods may co-occur; the multipliers do not compound, so the
loudest wins and helmetless-and-coveting is 4x rather than 8x.

The activity floor is untouched. More often never means talking into an empty room,
and a mood still produces silence when there is no way into what people are actually
discussing.

Each utterance is seeded with one premise drawn from a pool, sampled per message
rather than per Ceremony, so days of one mood do not become one sentence repeated.
The pools are premises for the model to build from, never lines to be spoken.

### Tagging on a version bump

A version change on `main` now tags itself and the tagged release builds the
container, so cutting a release is a version bump and nothing else.

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
