# discord-pakled-helmetbot

Pakled leader wear biggest helmet, but helmet need to switch. But which helmet is mine?

A Discord bot that owns ten ranked "helmet" roles and redistributes them among your
server every few days, in a theatrical Ceremony narrated by a Pakled who has lost
the Biggest Helmet and cannot remember what it looked like. It will never work out
that the plan cannot work.

Between Ceremonies it lurks in one channel, answers when mentioned, and
occasionally interjects — but only when there is real conversation to join.

## Running it

### What you need first

1. **A Discord application** with a bot user. In the Developer Portal, under
   **Bot → Privileged Gateway Intents**, enable **both**:
   - **Server Members** — to enumerate who may receive a helmet
   - **Message Content** — to read conversation

   Without both, the gateway refuses the connection outright.

2. **Invite the bot** with exactly the four permissions it needs — View Channels,
   Send Messages, Read Message History, Manage Roles:

   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=268504064
   ```

3. **Move the bot's role above where the helmets will sit**, in Server Settings →
   Roles. Discord will not let it manage a role at or above its own position, and
   members whose own highest role outranks the bot cannot receive helmets at all.

4. **An OpenRouter API key** — optional. Without one the bot still provisions
   helmets and runs Ceremonies, speaking in static fallback lines.

### Configuration

Two files, one mounted directory:

- `config.yaml` — behaviour. Copy [config.example.yaml](config.example.yaml) and
  edit. The bot only ever reads it.
- `bot.sqlite` — state. The bot is the only writer.

Identity and secrets come from the environment instead — see
[.env.example](.env.example):

| Variable | |
| --- | --- |
| `DISCORD_TOKEN` | required |
| `DISCORD_GUILD_ID` | required |
| `OPENROUTER_API_KEY` | optional; without it the Pakled speaks in fallback lines |
| `PAKLED_DATA_DIR` | where `config.yaml` and `bot.sqlite` live (`/data` in the container) |
| `PAKLED_LOG_LEVEL` | optional; overrides `logging.level`, so raising it is a restart rather than a config edit |

### With Docker

Images are published to GHCR on tagged releases, for `linux/amd64` and
`linux/arm64`.

```sh
mkdir -p ./pakled-data
cp config.example.yaml ./pakled-data/config.yaml   # then edit it

docker run -d --name pakled \
  -v "$PWD/pakled-data:/data" \
  -e DISCORD_TOKEN=... \
  -e DISCORD_GUILD_ID=... \
  -e OPENROUTER_API_KEY=... \
  ghcr.io/sanfam/discord-pakled-helmetbot:latest
```

Give it room to stop. A narrated Ceremony runs for minutes, and the bot waits for
one in progress before exiting:

```sh
docker stop --timeout 60 pakled
```

A Ceremony interrupted anyway is not lost — the next start recovers it.

### From source

Node 24 or newer (`node:sqlite` is flagged before 23.4).

```sh
npm ci
cp .env.example .env               # then populate it
mkdir -p data && cp config.example.yaml data/config.yaml

npm run dev            # start: connect, provision helmets, then run
npm run dev ceremony   # perform one Ceremony now
npm run dev golden     # regenerate character samples
```

`npm run dev` on its own reports readiness and refuses to manage roles if the
guild is not set up correctly, without changing anything.

## Commands

Watching is open to everyone. Steering is for the server owner and whoever they
appoint. Only the owner may appoint, because an admin who can appoint admins is an
admin forever.

| | |
| --- | --- |
| `/helmet status` | private schedule, deployed package version, uptime, passive activity and aggregate memory diagnostics *(admin)* |
| `/helmets where [page]` | in-character list of helmet holders *(everyone)* |
| `/helmet roles [page]` | who has which helmet |
| `/helmet next` | when the next Ceremony is due *(admin)* |
| `/helmet pause` | stop running Ceremonies *(admin)* |
| `/helmet resume` | resume, and clear any circuit breaker *(admin)* |
| `/helmet ceremony` | hold a Ceremony now *(admin)* |
| `/helmet admin add @user` | let someone steer the bot *(owner)* |
| `/helmet admin remove @user` | stop someone steering it *(owner)* |
| `/helmet admin list` | who may steer it *(admin)* |
| `/helmet debug-dm enable [recipient] [expiration]` | send the log to somebody as it happens *(admin)* |
| `/helmet debug-dm disable [recipient]` | stop sending it *(admin)* |
| `/helmet debug-dm status` | who is being sent it *(admin)* |

Status is ephemeral, visible only to the requesting Server Owner or Bot Admin. Memory diagnostics contain counts and settings, never note bodies. The randomized next Ceremony time is available only through private admin commands. `/helmet roles [page]` remains a public holder-list alias. Holder snapshots are shared for up to 30 seconds to limit Discord member requests.

`debug-dm` streams the log by direct message so that watching the bot does not mean
having a shell on the host. It always carries debug detail whatever `logging.level`
is set to, batches bursts into one message every five seconds, and only ever goes to
someone who may already steer the bot — log lines carry channel and user ids.
`expiration` takes a number and a unit (`90m`, `2h`, `3d`, `1y`, up to a year) and
defaults to an hour; an unreadable one is refused rather than guessed at.

### Recorded helmet history ([#22](https://github.com/Sanfam/discord-pakled-helmetbot/issues/22))

Completed, real Ceremonies supply bounded helmet-history facts (the Biggest Helmet by default). The Pakled may use
those records when someone asks about a named member: assignment counts, the current
and previous recorded holders, repeated assignments, and the exact duration of the
current recorded run. These are recorded assignments, not proof that a Discord role
was held continuously. Unknown members or ambiguous names require clarification, and
the lost helmet remains unidentified; history cannot reveal which helmet it was.
Direct duration questions use verified records and exact deterministic wording. Mention
the member, or ask about yourself explicitly; a display name alone is not an identity.

Ceremony history is separate from personal memory. Clearing or forgetting personal
notes never changes Ceremony records.

Voice and extraction acceptance scenarios: [memory evaluations](docs/evaluations/memory.md).

### Optional personal memory ([#23](https://github.com/Sanfam/discord-pakled-helmetbot/issues/23))

Personal memory stores a small number of expiring topic notes, not a transcript. It is
off by default. `learning: direct` considers a member's direct turns; `learning:
expanded` may also consider a member's turn when it led to an optional response that
was actually delivered. Generated Pakled speech is never stored as a member fact.
Only the member's own explicit, ordinary interests, projects, preferences, or harmless
jokes qualify. Extraction is instructed to omit sensitive disclosures, secrets,
third-party claims and uncertain attribution; these semantic judgments remain fallible.
Plans and unknown outcomes stay qualified, and figurative speech must not become a literal event. Corrections
replace the matching note; retractions remove it. Notes expire after 60 days and are
limited to five per member, with tags up to 64 characters and summaries up to 320.
Recall is limited to five notes and 2,000 rendered characters; extraction times out
after 5,000 ms. Housekeeping removes expired notes at startup and hourly, including
when memory is disabled.

Personal recall additionally requires a shared topic word with the newest human message
before notes enter the model prompt. This conservative filter can omit paraphrases;
it does not replace permission checks or the model’s relevance judgment.

The controls are always ephemeral. Members control only their own notes; the
Server Owner or a Bot Admin may inspect another member's notes. Administrator access
can disclose note contents, so server activation is not member consent; a consent or
onboarding flow is deferred.

```text
/helmet memory inspect [user] [page]
/helmet memory forget note:<id> [whole-topic]
/helmet memory clear
/helmet memory disable [clear]
/helmet memory enable
/helmet memory scope value:channel|category
```

`clear` deletes live note storage but does not disable memory, erase backups or forensic
copies, or touch Ceremony records. `disable` stops learning and recall for that member;
`disable clear` also deletes their live notes. A member opt-out always wins. Memory
exclusions inherit `participants.excludedUserIds` and `participants.excludedRoleIds`
unless the corresponding memory list is explicitly supplied.

Channel scope keeps a note in its source channel. Category scope shares only between
ordinary text channels whose current permissions exactly match the permissions captured
with the note. Categorized sources may share within their category, never upward or across
categories. Uncategorized sources may share into eligible uncategorized or categorized
destinations. Moving the source invalidates its captured provenance rather than broadening
recall. Public-thread notes stay in their source thread. Private
threads are unsupported and fail closed.

## Conversational engagement

Direct mentions and verified replies to Grunk, including replies with the ping disabled,
use the ordinary mention limits. After a successful direct reply, Grunk can consider new
unmentioned follow-ups in that channel. One human is enough to continue an invited exchange;
a model decision still determines whether there is something relevant to say. Laughter,
acknowledgments, finished jokes, and unrelated discussion should usually be left alone.

`conversation.engagement` controls this temporary attention: by default it expires after
five minutes without human activity or fifteen minutes since the latest explicit engagement.
Optional follow-ups wait for fifteen seconds of quiet. Bot messages never extend attention.
Set `engagement.enabled: false` to disable unmentioned follow-ups independently of passive entry.

Unsolicited entry uses `conversation.passive`: checks every 2–5 minutes, three human messages
from two authors within ten minutes, and a latest message no older than two minutes. The
25% probability is a chance to ask the model, not a guarantee of speech. The twenty-minute
channel cooldown is refreshed by optional speech, never by a direct reply; invited follow-ups
can continue during that cooldown. Mood can shorten the base check interval.

Fresh human input is required after speaking or evaluating a conversation. New messages or
direct replies invalidate pending optional output before the final application-controlled
send check. A message already submitted to Discord cannot be recalled by that check.
Optional work is bounded and gives priority to direct exchanges.

Attention and activity windows are in memory and restart empty; only activity/cooldown
timestamps persist. No transcript is retained; optional topic memory is described in
[#23](https://github.com/Sanfam/discord-pakled-helmetbot/issues/23). Existing explicit YAML values remain
authoritative on upgrade: copy the new settings from `config.example.yaml` to adopt the
new cadence. Timing values are starting settings, not empirically optimal values.

See [conversation evaluation cases](docs/evaluations/conversation.md) for the qualitative
criteria behind the prompt changes. Semantic relevance remains a model judgment, not a
promise that every follow-up will be recognized or every reply will be correct.

Follow-through requires a new human turn after Grunk's delivered reply. An extra
thought posted while Grunk is still composing does not itself schedule another
answer; it may appear in fetched context, but a fresh turn after delivery is needed
for optional follow-through. Any direct answer in the guild takes priority over
optional work, even in another channel. Busy optional work is dropped rather than
queued; debug logs explain these deferrals.

## The character

The runtime prompt lives in [prompts/pakled-conversation.md](prompts/pakled-conversation.md)
and is loaded at startup, so the voice can be revised without a code change.
[prompts/golden.md](prompts/golden.md) holds fixed sample inputs with generated
responses — regenerate with `npm run dev golden <model...>` after editing the
prompt, and read them. Voice is a taste judgement; there is no assertion for it.

The model is a configuration string. The request is deliberately the cheapest,
plainest one that still sounds right: reasoning disabled, no tools, routed by
price. Reasoning models actively broke the character — their preamble defeats the
response contract and their thinking tokens exhaust the budget.

## Design notes

- [CONTEXT.md](CONTEXT.md) — the domain glossary. Use its vocabulary.
- [docs/adr/](docs/adr/) — decisions that would otherwise look wrong later.
- [docs/proposal/](docs/proposal/) and [docs/personas/](docs/personas/) —
  origination artifacts. Read them; don't amend them.
