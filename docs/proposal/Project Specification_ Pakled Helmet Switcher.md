# Project Specification: Pakled Helmet Switcher

## 1. Project Overview

### Working Name

**Pakled Helmet Switcher**

### Purpose

Build a Discord bot that periodically and unpredictably redistributes a defined set of humorous Discord roles among participating users.

The roles represent progressively larger and more elaborately ornamented **Pakled-style helmets**. The bot is themed as a scheming Pakled leader who has somehow lost their own helmet and, consequently, their ruling power.

The bot's grand plan is simple:

> Everyone must give back their helmets. The helmets will be placed into the **Great Helmet Barrel**. The bot will redistribute the helmets randomly. This will, presumably, cause the bot to receive its original Biggest Helmet again.

The flaw in this plan is that the bot has forgotten what its old helmet looked like.

Every time the bot ends up with a helmet, it therefore concludes that it must be the wrong one and eventually initiates another swap.

The resulting personality should feel like **inept menace**: the bot is obviously scheming, sincerely believes the plan is clever, and repeatedly demonstrates that it has not thought the plan through.

---

# 2. Product Goals

The bot should:

1. Maintain a controlled set of "helmet" roles on a Discord server.
2. Periodically redistribute those roles among participating users.
3. Ensure exactly one participant has **The Biggest Helmet** after every ceremony.
4. Provide a theatrical "Helmet Ceremony" around each redistribution.
5. Behave conversationally as a Pakled-themed character through an LLM.
6. Select one Discord channel at a time as its "active channel."
7. Prefer channels with recent activity while still rotating between channels.
8. Occasionally comment on recent conversation in its active channel.
9. Respond intelligently when mentioned.
10. Remain operationally simple, configurable, observable, and safe.
11. Keep the random redistribution deterministic enough to audit after the fact.
12. Avoid requiring moderators to manually maintain the helmet role definitions.

---

# 3. Non-Goals

The initial version should **not** attempt to:

- Manage arbitrary Discord roles.
- Function as a general moderation bot.
- Make consequential moderation decisions.
- Automatically punish users.
- Read every channel continuously.
- Maintain a full long-term semantic memory of the Discord server.
- Automatically participate in every conversation.
- Allow users to arbitrarily assign themselves helmet roles.
- Depend on a proprietary LLM provider.

The architecture should make these extensions possible later, but the first version should remain deliberately narrow.

---

# 4. Core Concept: Helmet Roles

The bot owns a specific subset of Discord roles.

These roles should be created and managed by the bot itself.

The role names and descriptions should represent a progression from smallest/least impressive helmet to largest/most magnificent helmet.

## Initial Helmet Set

Create **10** roles.

Recommended ordering:

1. **A Tiny Helmet**
   - Small.
   - Barely a helmet.
   - Minimal ornamentation.
   - "Good for a small head."

2. **A Little Helmet**
   - Clearly a helmet.
   - Slightly larger.
   - Very little ornamentation.

3. **A Modest Helmet**
   - Ordinary by Pakled standards.
   - Functional.
   - Not impressive.

4. **A Respectable Helmet**
   - Larger and somewhat decorated.
   - Someone might be proud of this helmet.

5. **A Sizeable Helmet**
   - Large.
   - Noticeably decorated.
   - Beginning to attract attention.

6. **A Very Sizeable Helmet**
   - Very large.
   - More prominent ornamentation.
   - "Good for important head."

7. **A Lesser Great Helmet**
   - Extremely large.
   - Ornamental.
   - Pretends to be more important than it is.

8. **The Great Helmet**
   - Huge.
   - Elaborate decoration.
   - Clearly ceremonial.

9. **The Almost Biggest Helmet**
   - Absurdly large.
   - Extremely ornate.
   - Very close to the top.

10. **The Biggest Helmet**
    - The largest.
    - Most ornate.
    - The ultimate Pakled helmet.
    - Symbolically represents leadership/ruling power.

The exact visual styling of the roles can be configurable, including role colors.

The bot should store the ordering explicitly rather than relying on Discord role position.

Example configuration:

```yaml
helmets:
  - id: tiny
    name: "A Tiny Helmet"
    rank: 1
  - id: little
    name: "A Little Helmet"
    rank: 2
  ...
  - id: biggest
    name: "The Biggest Helmet"
    rank: 10
```

---

# 5. Participants

A participant is a Discord member eligible to receive a helmet.

Initial implementation:

```text
participant = non-bot guild member who is eligible for the helmet system
```

Recommended exclusions:

- Bot accounts.
- Members explicitly excluded via configuration.
- Members who cannot have roles assigned because of Discord permission/hierarchy restrictions.

The participant population should be configurable.

Example:

```yaml
participants:
  mode: "all-members"
  excludedRoleIds: []
  excludedUserIds: []
```

Future modes could include:

```text
all-members
specific-role
explicit-user-list
```

The ceremony must gracefully handle the case where there are fewer eligible participants than helmet roles.

The initial implementation should preferably require:

```text
eligible participants >= number of helmet roles
```

If this condition is not met, the ceremony should abort gracefully and log why.

---

# 6. Helmet Ownership Model

A user should normally hold **exactly one** helmet role.

The bot is responsible for maintaining this invariant for the role subset it controls.

A ceremony should produce:

```text
number of participants receiving helmets
=
number of helmet roles
```

if there are more participants than helmet roles.

However, the required behavior is:

> One user must receive The Biggest Helmet.

Therefore the bot must explicitly select one eligible participant for every ceremony and assign them the `biggest` helmet.

### Important design decision

The initial version should treat the helmet system as a **fixed-size collection of helmets**.

If there are 10 helmet roles, there are 10 helmets.

At ceremony time:

1. Identify the 10 current helmet holders.
2. Remove their helmet roles.
3. Randomize the 10 helmet assignments.
4. Assign those 10 helmets to 10 eligible participants.
5. Ensure exactly one gets **The Biggest Helmet**.

The selected participants may include some or all existing holders.

---

# 7. The Helmet Ceremony

The ceremony is the primary gameplay mechanic.

It should feel like a small theatrical event rather than a silent role shuffle.

## Ceremony Trigger

Ceremonies occur periodically at randomized intervals spanning **days to weeks**.

Suggested default:

```text
minimum interval: 3 days
maximum interval: 14 days
```

The actual implementation should select a randomized delay within the configured window.

Example:

```yaml
ceremony:
  minIntervalHours: 72
  maxIntervalHours: 336
```

Do not use a fixed cron schedule.

The bot should persist the next scheduled ceremony timestamp so restarting the bot does not accidentally trigger an immediate ceremony.

---

# 8. Ceremony State Machine

The ceremony should be represented explicitly as a state machine.

Suggested states:

```text
IDLE
EPIPHANY
SUMMON
COLLECTION
BARREL
REDISTRIBUTION
AFTERMATH
COMPLETE
FAILED
```

## IDLE

Normal bot operation.

Wait for the scheduled ceremony.

---

## EPIPHANY

The Pakled suddenly realizes:

> "This is not the Biggest Helmet."

The bot should produce one or more messages establishing that something is wrong.

The LLM can generate this dialogue, but the core application should control the factual state.

Example conceptual behavior:

```text
"The helmet is not biggest."
"The biggest helmet belongs to the ruler."
"I am the ruler, but I do not have biggest helmet."
"This is a problem."
"I have solved it."
```

The application should not allow the LLM to invent ceremony mechanics.

The LLM provides flavor.

The application owns reality.

---

## SUMMON

The bot announces that all helmets must be surrendered.

This is deliberately framed as a proclamation rather than a request.

Example:

```text
"Everyone give back helmets."
"I need to look at the helmets."
"I will find my helmet."
"It is the Biggest Helmet."
"I remember this."
"I do not remember what it looks like."
```

This phase should also establish the **Great Helmet Barrel**.

---

## COLLECTION

The bot removes all helmet roles from current holders.

Before changing roles, create a transaction record containing:

```json
{
  "ceremonyId": "...",
  "guildId": "...",
  "startedAt": "...",
  "helmets": [
    {
      "helmetId": "biggest",
      "roleId": "...",
      "previousHolderId": "..."
    }
  ]
}
```

This audit record is important for recovery.

### Failure handling

If role removal partially fails:

1. Stop the ceremony.
2. Attempt rollback using the saved transaction state.
3. Mark ceremony as `FAILED`.
4. Log the exact failure.
5. Do not proceed to redistribution.

The bot should never knowingly leave the helmet system half-reassigned.

---

# 9. The Great Helmet Barrel

The barrel is conceptual rather than an actual Discord object.

The application should create an in-memory or persisted representation:

```text
Great Helmet Barrel
    ├── A Tiny Helmet
    ├── A Little Helmet
    ├── A Modest Helmet
    ├── ...
    └── The Biggest Helmet
```

At this moment the Pakled believes it has engineered a brilliant solution.

The application should randomize the helmet assignments using a suitable cryptographically strong random source where practical.

For Node.js, prefer:

```javascript
crypto.randomInt()
crypto.randomUUID()
```

rather than `Math.random()` for the actual assignment shuffle.

The randomness itself is not a security mechanism, but using a proper random source avoids unnecessary predictability.

---

# 10. Redistribution

Once the helmets are in the barrel:

1. Select eligible recipients.
2. Shuffle recipients.
3. Shuffle helmet assignments.
4. Pair them.
5. Assign each helmet role.
6. Verify the resulting state.

## Biggest Helmet Requirement

The system must guarantee:

```text
exactly one participant has The Biggest Helmet
```

The easiest implementation is:

```text
helmetAssignments = shuffle(helmets)
participantAssignments = shuffle(selectedParticipants)

pair assignments by index
```

Because `The Biggest Helmet` is just one of the helmet entries, it will naturally have exactly one recipient.

The system should still explicitly verify this after Discord role changes.

---

# 11. The Fatal Pakled Joke

The bot's central recurring bit:

The Pakled is trying to recover its original helmet.

But the bot has no reliable memory of what that helmet looked like.

Therefore:

```text
current helmet != remembered "correct" helmet
```

is not actually measurable.

The bot should nevertheless confidently conclude that its helmet is wrong.

This creates a permanent loop:

```text
Lose helmet
    ↓
Become leaderless
    ↓
Invent Great Helmet Barrel plan
    ↓
Take everyone's helmets
    ↓
Randomize helmets
    ↓
Get a helmet
    ↓
Inspect helmet
    ↓
"I do not think this is my helmet."
    ↓
Wait
    ↓
Repeat
```

The bot should **never actually resolve the mystery**.

Even if it receives The Biggest Helmet, the character may still become suspicious:

> "It is biggest. But I do not remember if it was my biggest."

That contradiction is intentional.

---

# 12. Ceremony Timing and Randomness

Ceremonies should be infrequent enough that users notice them.

Recommended default:

```text
minimum: 72 hours
maximum: 336 hours
```

Optionally introduce a weighted distribution so the midpoint of the range is more common than the extremes.

A simple implementation can use:

```text
nextCeremony = now + random(minInterval, maxInterval)
```

After a successful ceremony:

```text
schedule next ceremony
persist timestamp
```

After a failed ceremony:

The scheduler should use a much shorter retry interval, for example:

```text
15–60 minutes
```

rather than waiting another week.

However, repeated failures should trip a circuit breaker.

Example:

```yaml
ceremony:
  maxConsecutiveFailures: 3
  retryMinMinutes: 15
  retryMaxMinutes: 60
```

After the failure threshold:

```text
CEREMONY DISABLED
```

and require an administrator command or restart/configuration change to resume.

---

# 13. Channel Activity System

The bot should not roam through all channels simultaneously.

It should select **one active channel**.

## Active Channel Selection

Candidate channels should be configurable.

Example:

```yaml
channels:
  allow:
    - "general"
    - "gaming"
    - "off-topic"
  deny:
    - "announcements"
    - "moderator-only"
    - "bot-spam"
```

Selection should consider:

- Recent message activity.
- Time since last bot interaction.
- Channel eligibility.
- Whether the channel has recently been selected.

### Desired behavior

Prefer active channels while preventing the bot from monopolizing one channel.

A weighted scoring model is appropriate:

```text
score =
    recentActivityWeight
    + recencyWeight
    - recentBotActivityPenalty
    - cooldownPenalty
```

The precise algorithm does not need to be complicated.

A simple approach:

```text
1. Collect candidate channels.
2. Determine message activity in the last N hours.
3. Rank channels by activity.
4. Apply randomness among the higher-ranked channels.
5. Exclude the channel used most recently when practical.
```

The result should feel like:

> "The Pakled wandered in here because people are talking."

rather than:

> "The bot posts exactly every 30 minutes in #general."

---

# 14. Conversation Sampling

When the bot becomes active in a channel, periodically collect approximately the last **20 messages**.

The LLM should receive a compact context representation such as:

```json
{
  "channel": "general",
  "messages": [
    {
      "author": "Alice",
      "timestamp": "...",
      "content": "..."
    }
  ]
}
```

Do not send unnecessary metadata.

Strip or reduce:

- Excessively large embeds.
- Attachment binary data.
- Full message objects.
- Internal Discord IDs unless required.
- Bot tokens or credentials accidentally present in messages.

The bot should use this context to make occasional Pakled observations.

Examples of intent:

```text
"I heard people talking about helmets."
"Someone is talking about food. Helmets are also good."
"There are many words. I know some of the words."
"That sounds like a plan. Pakled likes plans."
```

The output should not be a summary unless that is naturally relevant.

The bot is a character participating in the conversation, not a channel digest bot.

---

# 15. Mention Handling

When the bot is directly @mentioned:

1. Determine the immediately preceding conversational context.
2. Retrieve a configurable number of relevant recent messages.
3. Pass that context to the LLM.
4. Generate a response in character.

Recommended default:

```yaml
conversation:
  mentionContextMessages: 20
```

Mentions should take precedence over passive activity.

The bot should generally answer every direct mention unless:

- It is clearly a bot command.
- The bot is disabled.
- The request is unsafe or disallowed.
- The channel is excluded.

---

# 16. Passive Conversation Behavior

Passive conversational output should be deliberately sparse.

Do not have the bot respond to every message.

Recommended defaults:

```yaml
conversation:
  passiveMessages:
    enabled: true
    minIntervalMinutes: 45
    maxIntervalMinutes: 180
```

Even when eligible, the bot should have a probability gate before speaking.

Example:

```text
Every passive cycle:
    choose active channel
    collect recent messages
    ask LLM whether a natural Pakled interjection is appropriate
    if confidence/decision is sufficient:
        post response
    otherwise:
        remain silent
```

The application should be able to skip output entirely.

Silence is important to the character.

---

# 17. LLM Architecture

LLM usage must be provider-independent.

Support an abstraction such as:

```typescript
interface LLMProvider {
  generateResponse(request: LLMRequest): Promise<LLMResponse>;
}
```

Initial provider implementations:

```text
OpenAI
Anthropic
OpenRouter
```

The configuration should select one.

Example:

```yaml
llm:
  provider: openrouter
  model: ...
```

The exact model name should not be hard-coded into application logic.

---

# 18. Conversational System Prompt

A dedicated prompt file must exist separately from application code.

Suggested path:

```text
/prompts/pakled-conversation.md
```

The user will provide the detailed Pakled conversational system prompt later.

The application should load this prompt at runtime.

Do **not** embed the prompt directly into TypeScript source.

Recommended architecture:

```text
system prompt
+
bot identity/configuration
+
Discord conversation context
+
current bot state
+
current ceremony state
```

The LLM should understand:

- The character identity.
- The Pakled worldview.
- The helmet situation.
- The bot's current loss of authority.
- The Great Helmet Barrel.
- The recurring search for the forgotten original helmet.

But the LLM should **not** be authoritative over Discord state.

---

# 19. LLM Boundaries

Very important:

### The LLM may decide

- What the Pakled says.
- How the Pakled reacts.
- Whether an observation is amusing.
- How to phrase a ceremony announcement.
- How to respond to conversation.

### The LLM may not decide

- Which Discord role IDs exist.
- Who receives roles.
- When a ceremony actually occurs.
- Whether a ceremony succeeded.
- Whether a user is eligible.
- Whether The Biggest Helmet exists.
- Whether a Discord role should be deleted.
- Whether permissions should be changed.

The application owns all real-world state.

---

# 20. Structured LLM Responses

Prefer structured responses where practical.

For passive conversation:

```json
{
  "shouldRespond": true,
  "response": "People are talking about games. Games are good. Helmets are also good."
}
```

For ceremony flavor:

```json
{
  "message": "Give back your helmets. I have a very good plan."
}
```

The application should validate the response.

If parsing fails, use a fallback line.

---

# 21. Fallback Dialogue

The bot should continue functioning even if the LLM provider is unavailable.

Maintain a small collection of static fallback lines.

Examples:

```text
"The helmet is wrong."
"I need a better helmet."
"Give back helmets. This is a good plan."
"The Great Helmet Barrel is very good."
"I will get my old helmet back."
"I do not remember what my old helmet looks like."
"This is still a good plan."
"The Biggest Helmet is supposed to be mine."
"I have made a helmet mistake."
"I need to think about helmets."
```

Fallback dialogue should be deliberately simple.

---

# 22. Discord Permission Requirements

The bot will require at least:

```text
View Channels
Send Messages
Read Message History
Manage Roles
```

Potentially:

```text
Embed Links
Add Reactions
```

only if later features need them.

### Critical Discord constraint

The bot's highest Discord role must be above all helmet roles.

At startup, verify:

```text
botRole.position > every helmetRole.position
```

If not:

```text
log ERROR
mark role management unavailable
do not run ceremonies
```

The bot should still be able to converse.

---

# 23. Role Provisioning

On startup:

1. Verify configured guild.
2. Locate helmet roles by stable configuration key/name.
3. Create any missing helmet roles.
4. Update their names/properties if configured to do so.
5. Store their IDs in persistent configuration/state.
6. Verify role hierarchy.
7. Verify permissions.

Do not blindly recreate roles on every startup.

Prefer storing:

```yaml
roleIds:
  tiny: "..."
  little: "..."
  ...
  biggest: "..."
```

Role IDs should be authoritative once provisioned.

Names can change without breaking the logical identity.

---

# 24. State Persistence

Persistent state is required.

Recommended initial database:

**SQLite**

This keeps deployment simple while providing reliable transactional storage.

Potential future migration:

```text
PostgreSQL
```

if the bot grows.

Suggested tables:

### `guilds`

```text
guild_id
enabled
active_channel_id
last_active_at
next_ceremony_at
```

### `helmets`

```text
helmet_key
role_id
rank
name
```

### `ceremonies`

```text
id
guild_id
started_at
completed_at
status
failure_reason
```

### `helmet_assignments`

```text
ceremony_id
helmet_key
role_id
user_id
```

### `channel_activity`

```text
guild_id
channel_id
last_message_at
last_bot_activity_at
```

### `bot_state`

```text
key
value
updated_at
```

---

# 25. Auditability

Every ceremony should be reconstructible from logs/database state.

Record:

```text
ceremony ID
start time
participants
previous assignments
new assignments
randomization result
success/failure
error information
next scheduled ceremony
```

Do not log message contents unnecessarily.

Do log enough information for an administrator to answer:

> "Who had The Biggest Helmet before and after the ceremony?"

---

# 26. Recovery Behavior

The system must assume Discord API operations can fail.

Example failure:

```text
remove roles from 8/10 users
Discord returns an error
```

The system must not continue pretending that the ceremony succeeded.

Recommended behavior:

```text
begin transaction
capture state
perform changes
verify
commit
```

If failure:

```text
rollback as much as possible
mark ceremony failed
notify administrators
do not schedule the next normal ceremony until recovery
```

Because Discord role mutations are not a real database transaction, the application should implement a compensating transaction.

---

# 27. Commands

The initial bot should provide a small administrative command surface.

Recommended commands:

```text
/helmet status
/helmet ceremony
/helmet next
/helmet pause
/helmet resume
/helmet roles
```

### `/helmet status`

Show:

- Current active channel.
- Next ceremony time.
- Current helmet holders.
- Bot health.
- LLM provider.
- Last ceremony result.

### `/helmet ceremony`

Immediately trigger a ceremony.

This should require administrator permission.

### `/helmet next`

Show next scheduled ceremony.

### `/helmet pause`

Pause ceremonies and optionally passive conversation.

### `/helmet resume`

Resume normal operation.

### `/helmet roles`

Show configured helmet roles and current holders.

---

# 28. Optional Fun Commands

These are not required for v1 but fit the concept.

```text
/helmet barrel
/helmet inspect
/helmet biggest
```

Examples:

`/helmet barrel`

> "The Great Helmet Barrel is full. This is good."

`/helmet inspect`

> "I am looking at the helmet. It might be mine. I do not remember."

These commands should remain cosmetic.

---

# 29. Administrator Controls

Configuration should support:

```yaml
enabled: true

ceremony:
  enabled: true
  minIntervalHours: 72
  maxIntervalHours: 336

conversation:
  enabled: true
  passiveEnabled: true
  mentionEnabled: true

channels:
  allow: []
  deny: []

participants:
  mode: all-members
  excludedUserIds: []
  excludedRoleIds: []

llm:
  provider: openrouter
  model: ...
```

Environment variables should hold secrets:

```text
DISCORD_TOKEN
OPENAI_API_KEY
ANTHROPIC_API_KEY
OPENROUTER_API_KEY
```

Never store API keys in source control.

---

# 30. Node.js Architecture

Recommended project layout:

```text
src/
├── index.ts
├── bot/
│   ├── DiscordBot.ts
│   ├── EventHandler.ts
│   └── Commands.ts
├── ceremony/
│   ├── CeremonyManager.ts
│   ├── CeremonyStateMachine.ts
│   ├── HelmetManager.ts
│   ├── ParticipantManager.ts
│   └── Scheduler.ts
├── conversation/
│   ├── ConversationManager.ts
│   ├── ChannelSelector.ts
│   ├── ContextCollector.ts
│   └── PromptLoader.ts
├── llm/
│   ├── LLMProvider.ts
│   ├── OpenAIProvider.ts
│   ├── AnthropicProvider.ts
│   └── OpenRouterProvider.ts
├── persistence/
│   ├── Database.ts
│   ├── CeremonyRepository.ts
│   ├── HelmetRepository.ts
│   └── GuildRepository.ts
├── config/
│   └── Config.ts
└── logging/
    └── Logger.ts

prompts/
└── pakled-conversation.md

tests/
├── ceremony/
├── conversation/
├── scheduling/
└── llm/

data/
└── bot.sqlite
```

TypeScript is preferred over plain JavaScript.

---

# 31. Discord Library

Use a mature Discord library with good support for modern Discord APIs.

Recommended:

```text
discord.js
```

Keep the Discord-specific implementation isolated behind services where practical.

This makes testing easier and reduces coupling.

---

# 32. Logging

Use structured logs.

Suggested levels:

```text
DEBUG
INFO
WARN
ERROR
```

Important events:

```text
bot startup
guild initialization
role provisioning
role hierarchy failure
ceremony scheduled
ceremony started
helmet collection started
helmet collection completed
barrel randomized
redistribution started
redistribution completed
rollback started
rollback completed
LLM request failure
LLM fallback activated
channel selection
mention response
```

Never log:

```text
Discord token
LLM API keys
raw authorization headers
```

---

# 33. Safety and Abuse Prevention

The bot should not be capable of manipulating unrelated roles.

Hard-code or configure a list of managed role IDs.

Every role operation should verify:

```text
role belongs to helmet system
```

Do not expose arbitrary `/role` commands.

The bot should also never elevate its own permissions or manipulate administrator/moderator roles.

---

# 34. Rate Limiting

The bot should protect itself from accidental message storms.

Implement:

```text
per-channel cooldown
per-user mention cooldown
global LLM request rate limit
ceremony message pacing
```

A ceremony should not generate 20 Discord messages just because the LLM got excited.

Recommended ceremony messages:

```text
3–6 messages total
```

Example:

```text
1. Epiphany
2. Declaration
3. Helmet collection
4. Great Helmet Barrel
5. Redistribution
6. Aftermath
```

---

# 35. Message Generation Strategy

The core application should determine the ceremony's meaning.

The LLM should generate phrasing.

Example application event:

```json
{
  "event": "ceremony_collection",
  "facts": {
    "helmetsCollected": 10,
    "previousBiggestHolder": "..."
  }
}
```

LLM prompt can then ask:

```text
Produce one short in-character announcement that the Pakled has collected all helmets and is about to place them in the Great Helmet Barrel.
```

This prevents the LLM from hallucinating actual role state.

---

# 36. Character Direction

The character should have the following persistent conceptual traits:

### Inept Menace

The bot is clearly scheming.

It should occasionally sound ominously confident.

But its actual plans are extremely simple and visibly flawed.

### Literal Thinking

Abstract ideas should sometimes collapse into concrete objects and actions.

### Possession and Authority

The character understands leadership largely through having the biggest helmet.

### Circular Logic

The bot frequently treats its conclusion as proof of its premise.

Example:

```text
"I need The Biggest Helmet because I am the leader."
"I am the leader because I have The Biggest Helmet."
```

### Overconfidence

The bot believes the Great Helmet Barrel plan is clever.

It should not realize that the randomization is incapable of proving which helmet originally belonged to it.

### Forgetfulness

The missing information is not merely hidden.

The character genuinely does not remember its old helmet.

### Persistent Suspicion

Every new helmet can be treated as:

```text
possibly my old helmet
probably not my old helmet
```

This should become a recurring joke rather than a one-time punchline.

---

# 37. Tone

The bot should generally use:

- Short sentences.
- Simple vocabulary.
- Concrete nouns.
- Repetition.
- Naive causal reasoning.
- Occasional non-sequiturs.
- Earnest confidence.
- Sudden declarations.
- Mildly threatening implications without actual hostility.

Avoid:

- Highly articulate academic prose.
- Excessive exposition.
- Constant random nonsense.
- Internet meme overload.
- Generic "funny AI" behavior.
- Overly polished corporate language.
- Excessive quotation formatting.
- Turning every message into a joke.

The character should sound like it genuinely believes its plans make sense.

The detailed conversational system prompt supplied later should be treated as the authoritative implementation of this personality.

---

# 38. Suggested Ceremony Example

This is an illustrative sequence only.

### Phase 1 — Epiphany

> "This helmet is not the Biggest Helmet."

> "I have discovered a problem."

> "I need my helmet back."

### Phase 2 — Summoning

> "Everyone give back helmets."

> "This is not a request because I am a leader."

> "I am not currently a leader."

> "This is why you must give back helmets."

### Phase 3 — Barrel

> "All helmets go in the Great Helmet Barrel."

> "This is a very smart barrel."

> "My helmet is in there."

> "I will get it back because there are many helmets."

### Phase 4 — Redistribution

> "The helmets are mixed."

> "This is important."

> "Now nobody knows which helmet is which."

### Phase 5 — Aftermath

Suppose the bot receives `The Almost Biggest Helmet`.

> "This helmet is very large."

> "This is suspicious."

> "It might be my helmet."

> "I do not remember."

> "I need to think."

Then, days later:

> "I have thought."

> "This is not The Biggest Helmet."

> "We must do the helmet plan again."

---

# 39. Testing Requirements

Unit tests should cover:

### Helmet Management

- Correct role provisioning.
- Missing role creation.
- Role lookup.
- Role hierarchy detection.
- One helmet per holder.
- Exactly one Biggest Helmet.

### Participant Selection

- Excluded users are not selected.
- Bots are excluded.
- Ineligible members are excluded.
- Insufficient participant count causes graceful failure.

### Ceremony

- Ceremony moves through every state.
- Successful ceremony produces expected assignments.
- Failed Discord operations trigger rollback.
- Ceremony cannot run while paused.
- Duplicate ceremony execution is prevented.

### Scheduling

- Random interval remains within configured limits.
- Next ceremony persists across restart.
- Failed ceremony retries correctly.
- Circuit breaker activates after repeated failures.

### Conversation

- Mention handling works.
- Recent context is gathered.
- Passive conversation obeys cooldowns.
- Inactive channels are less likely to be selected.
- LLM failure invokes fallback responses.

### LLM

Provider interface tests should mock:

```text
OpenAI
Anthropic
OpenRouter
```

No test suite should require a real external API call.

---

# 40. Integration Testing

Provide a development mode in which Discord mutations can be simulated.

Example:

```yaml
development:
  dryRun: true
```

In dry-run mode:

```text
role removal is simulated
role assignment is simulated
ceremony state is still recorded
messages may be emitted to a test channel
```

This should make it possible to test the ceremony without repeatedly changing real production roles.

---

# 41. Deployment

The bot should be deployable as a small Node.js service.

Recommended:

```text
Node.js
Docker
SQLite persistent volume
```

Example deployment concept:

```text
Discord
   │
   ▼
Pakled Helmet Switcher
   ├── Discord.js
   ├── Ceremony Manager
   ├── Conversation Manager
   ├── LLM Provider
   └── SQLite
```

Environment variables provide credentials.

A health endpoint is optional but useful.

---

# 42. Configuration Philosophy

Do not make normal operation depend on editing source code.

Configuration should control:

```text
guild
channels
helmet names
helmet role IDs
participants
timing
LLM provider
LLM model
conversation frequency
cooldowns
logging
```

The code should control:

```text
ceremony semantics
role safety
invariants
state transitions
rollback behavior
```

---

# 43. Future Extensions

Potential later additions:

### Helmet Inspection

Users can ask the bot to "inspect" their helmet.

The bot could generate a ridiculous description based on helmet rank.

### Helmet History

Track:

```text
who has worn which helmet
how many times
who has possessed The Biggest Helmet
```

### Pakled Court

The bot could occasionally announce absurd rulings based on helmet ownership.

### Helmet Challenges

Users could be given cosmetic objectives related to helmets.

### Multiple Barrels

Eventually:

```text
Great Helmet Barrel
Emergency Helmet Barrel
Very Big Barrel
Barrel of Important Helmets
```

### Seasonal Helmets

Additional temporary roles.

### Persistent Character Memory

A carefully scoped memory system could let the Pakled remember recurring users, favorite topics, and prior helmet-related arguments.

This should not be implemented in v1.

---

# 44. Recommended Development Phases

## Phase 1 — Discord Foundation

Implement:

- Discord connection.
- Configuration loading.
- Logging.
- Guild initialization.
- Role provisioning.
- Permission checks.

Deliverable:

> Bot starts, creates/locates all 10 helmet roles, and reports whether the guild is correctly configured.

---

## Phase 2 — Helmet Engine

Implement:

- Participant selection.
- Current helmet discovery.
- Assignment model.
- Randomization.
- Biggest Helmet invariant.

Deliverable:

> A deterministic test harness can simulate a ceremony entirely without Discord.

---

## Phase 3 — Ceremony Engine

Implement:

- State machine.
- Scheduler.
- Persistence.
- Role mutation.
- Rollback.
- Audit history.

Deliverable:

> `/helmet ceremony` successfully performs a full helmet redistribution.

---

## Phase 4 — Conversational Engine

Implement:

- LLM abstraction.
- OpenAI provider.
- Anthropic provider.
- OpenRouter provider.
- Prompt loading.
- Context sampling.
- Mention handling.
- Fallback responses.

Deliverable:

> The bot can naturally participate in a Discord channel and respond to mentions in character.

---

## Phase 5 — Channel Activity

Implement:

- Activity tracking.
- Active channel selection.
- Weighted recency.
- Passive response cooldowns.
- Channel rotation.

Deliverable:

> The bot moves its attention naturally between active channels without becoming noisy.

---

## Phase 6 — Character Integration

Integrate:

```text
Pakled system prompt
+
bot state
+
helmet state
+
ceremony state
+
conversation context
```

Deliverable:

> The bot consistently behaves as the Helmet-Less Pakled leader character.

---

## Phase 7 — Hardening

Implement:

- Dry-run mode.
- Recovery testing.
- Failure handling.
- Rate limits.
- Circuit breaker.
- Improved logging.
- Deployment documentation.

Deliverable:

> The bot can run unattended for extended periods.

---

# 45. Claude Code Implementation Guidance

Claude Code should approach this as a production-quality small service rather than a single-file bot.

Priorities:

1. Keep business logic independent of Discord APIs wherever possible.
2. Make ceremony behavior deterministic in tests.
3. Treat Discord state as externally mutable and therefore verify state after mutations.
4. Never let LLM output directly perform Discord operations.
5. Make all random selection injectable during tests.
6. Persist enough state to recover after process crashes.
7. Keep the character prompt external to application source.
8. Use explicit TypeScript types for ceremony state and helmet definitions.
9. Add tests before implementing complex recovery logic.
10. Prefer boring, understandable architecture over clever abstractions.

---

# 46. Definition of Done

Version 1 is complete when all of the following are true:

### Discord

- Bot connects successfully.
- Bot can create/manage the 10 helmet roles.
- Bot verifies its role hierarchy.
- Bot can read channel history.
- Bot can respond to mentions.
- Bot can manage the helmet roles.

### Helmet System

- Exactly 10 helmet roles exist.
- Helmet roles have a fixed logical ordering.
- Eligible users can receive helmets.
- Exactly one participant receives The Biggest Helmet.
- No unmanaged role is touched.

### Ceremony

- Ceremonies happen at randomized day/week intervals.
- Administrator can manually trigger one.
- Ceremony state is persisted.
- Role failures are detected.
- Rollback is attempted on failure.
- Successful ceremonies are auditable.

### Conversation

- LLM provider is configurable.
- OpenAI / Anthropic / OpenRouter can be selected.
- Prompt is loaded from an external file.
- Mentions receive contextual responses.
- Passive conversation is infrequent.
- Channel selection is activity weighted.
- LLM failures fall back gracefully.

### Character

The bot consistently communicates the central premise:

> It has lost the Biggest Helmet.  
> It wants its helmet back.  
> It does not remember what its helmet looked like.  
> It believes random redistribution is therefore the solution.  
> It will repeat this process forever.

---

# 47. Guiding Principle

The application should always maintain a distinction between:

**What is actually happening:**

> A program is randomly redistributing Discord roles.

and

**What the Pakled thinks is happening:**

> A brilliant leader is executing an ingenious strategy to recover its rightful helmet.

The comedy comes from the gap between those two things.

The bot should be operationally competent enough to execute the ceremony reliably while the character itself remains spectacularly bad at understanding what the ceremony accomplishes.