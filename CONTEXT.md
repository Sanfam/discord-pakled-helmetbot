# Pakled Helmet Switcher

A Discord bot that owns a ranked set of joke "helmet" roles and periodically redistributes them
among a server's members, in the voice of a Pakled leader searching for a helmet it cannot remember.

## Language

### Helmets

**Helmet**:
One of a fixed, ranked set of Discord roles owned and managed by the bot. A helmet has a stable
logical identity independent of its Discord role name or position.
_Avoid_: Hat, role (when a helmet is meant)

**Helmet Set**:
The complete ordered collection of helmets, from A Tiny Helmet (rank 1) to The Biggest Helmet
(rank 10). Its size defines how many helmets exist; there is no helmet outside the set.

**The Biggest Helmet**:
The highest-ranked helmet. It symbolises leadership, and exactly one member holds it after every
successful ceremony. This is the system's one hard invariant.

**Leftover Helmet**:
A helmet that no one received, because there were fewer eligible members than helmets. It stays
in the Great Helmet Barrel until the next ceremony.

### People

**Eligible Member**:
A guild member who may receive a helmet: not excluded by configuration, and assignable given
Discord's role hierarchy. Eligibility says nothing about whether they currently wear one.
_Avoid_: Participant (ambiguous: conflates eligibility with receipt)

**Helmet Holder**:
An eligible member who currently wears a helmet. The bot is always a helmet holder.
_Avoid_: Participant, winner, recipient

**The Pakled**:
The bot as a character: a leader who has lost the Biggest Helmet, does not remember what it looked
like, and believes random redistribution will return it. The Pakled is an eligible member and is
guaranteed a helmet in every ceremony.
_Avoid_: The bot (when the character is meant rather than the process)

### Events

**Ceremony**:
The theatrical event in which every helmet is collected, placed in the Great Helmet Barrel, and
redistributed. Ceremonies happen on a randomised multi-day interval and are the only sanctioned
way a helmet changes hands.
_Avoid_: Swap, shuffle, rotation, redistribution (that is one phase of a ceremony, not the whole)

**The Great Helmet Barrel**:
The conceptual container holding every helmet between collection and redistribution. It exists in
the bot's state and in the Pakled's imagination, never as a Discord object.

**Active Channel**:
The single channel the bot is currently paying attention to. It has exactly one at a time, chosen
by recent activity, and it is the only channel where the Pakled speaks unprompted.

**Passive Interjection**:
Unprompted speech by the Pakled in its active channel. Distinct from a reply to a direct mention,
which is always answered; an interjection is optional, rate-limited, and frequently declined.
_Avoid_: Passive message, random message

**Activity Floor**:
The minimum recent human conversation in a channel before a passive interjection may be considered
at all. Below the floor the Pakled stays silent: talking into an empty room is not a contribution.
