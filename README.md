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

| | |
| --- | --- |
| `/helmet status` | what is happening with the helmets |
| `/helmet next` | when the next Ceremony is due |
| `/helmet roles` | who has which helmet |
| `/helmet pause` | stop running Ceremonies *(Manage Server)* |
| `/helmet resume` | resume, and clear any circuit breaker *(Manage Server)* |

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
