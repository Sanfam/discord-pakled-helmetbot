# Rare ceremony outcomes shape a mood

A Ceremony may end in one of three states the Pakled has something to say about: someone was given
two helmets (the Multihat, 3%), every helmet was handed out and none kept back for the Pakled (8%),
or the Pakled has fixed on one helmet, on one person, as the one it lost (5%). Each is rolled
independently, recorded against the Ceremony that produced it, and stands until the next Ceremony
replaces it.

Going without is a deliberate exception to [ADR-0001](0001-the-pakled-is-a-helmet-holder.md). The
guarantee there exists so the loop has an engine — a bot with a helmet to be suspicious of. Having
*no* helmet is a stronger engine, not a weaker one: it is the only outcome the character cannot
explain away, and the only one where the fault is unmistakably its own. It is refused when it would
leave nobody holding a helmet at all, so the guarantee still holds whenever it is the only member.

A mood makes the bot speak unprompted more often — twice for going without or a Multihat, four
times for coveting — decaying back to its normal interval over about a day. Moods may co-occur, but
the multipliers do not compound: the loudest wins, because helmetless-and-coveting at 8x is a bot
nobody wants in their server.

## Consequences

The activity floor is untouched, so more often never means talking into an empty room, and a mood
still yields silence when there is no way into what people are discussing.

Each utterance is seeded with one premise sampled from a pool — why it thinks it has no helmet, or
which transparent scheme it is trying this time — so that days of one mood do not become one
sentence repeated. The pools are premises for the model to build from, never lines to be spoken.

Going without is recorded explicitly rather than read off the bot's roles. Mid-Ceremony every head
is bare, including its own, and that is not the same situation.
