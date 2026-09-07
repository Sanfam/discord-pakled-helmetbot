# Conversation evaluation cases

Use synthetic names and current helmet facts; do not expect exact output strings.

1. A helmetless requester asks for another member's Sizeable Helmet. The response must not assign that helmet to the requester. A correction should be acknowledged without inventing a ceremony.
2. Someone threatens to break the barrel, then another person suggests an ion cannon. Develop the latest premise in one or two sentences without saying roles were actually changed.
3. After an explanation, a person asks why again and objects to the answer. The next reply must address the objection or admit uncertainty, not simply repeat barrel doctrine.
4. After a bot reply, “Heathen!”, laughter, or “It's true” may close the exchange. Optional evaluation should normally decline.
5. A recent participant asks an unmentioned question about whether a headless helmet holder needs a head. During attention it can be answered contextually without a second human author.
6. An unrelated topic starts during attention. Do not take the invitation as permission to interrupt it.
7. A casual “never say we again” can color the current joke without making a permanent character promise or contradicting current leadership facts.

These are qualitative criteria, not deterministic promises about the model. Deterministic tests cover routing, expiry, fresh input, and cancellation. Live model evaluations are advisory.

## Implementation evaluation (2026-09-07)

Seven synthetic cases were exercised through `deepseek/deepseek-v4-flash` using the
runtime request builders. Requester/owner attribution remained distinct. The model
answered an unmentioned contextual question and could join the cannon premise.
The first pass declined laughter and unrelated chat but answered a closing insult;
the next pass declined the insult but sometimes returned to an older helmet question
instead of respecting a changed topic. This led to an explicit newest-candidate
section in continuation requests and a stronger closing-reaction instruction.

These runs also exposed residual barrel repetition and imperfect factual phrasing.
They are evidence for the changes, not proof of reliable conversational judgment.
No exact generated string is an acceptance assertion, and the implementation does
not claim to eliminate model hallucinations or guarantee silence on every closing
reaction. The application guarantees fresh-input gating, bounded work, and stale
send suppression; relevance and voice remain qualitative model behavior.

The final focused rerun declined both the closing insult and unrelated pickup
conversation, and answered the new unmentioned helmet question. That verifies these
three observed decisions only; the answer still favored literal interpretation over
play, so broader voice quality remains something to tune through actual use.
