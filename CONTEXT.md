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

**Server Owner**:
The one person Discord records as owning the guild. Ownership is Discord's fact, never the bot's:
it is read afresh each time it matters, because a stored copy is wrong the moment a server changes
hands. The Server Owner alone appoints and dismisses Bot Admins.
_Avoid_: Admin, superuser

**Bot Admin**:
Someone the Server Owner has trusted to steer the bot — the schedule, the Ceremonies, the log
stream. A Bot Admin may do everything the Server Owner may do except appoint another Bot Admin:
delegating the power to delegate turns one appointment into a permanent one. Being a Bot Admin
says nothing about Discord permissions, and Discord permissions confer nothing here.
_Avoid_: Moderator, operator, admin (unqualified)

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

### Operation

**Recorded Assignment Run**:
A sequence of successful Ceremonies assigning the same logical helmet to the same member.
It describes recorded assignments, not proof of uninterrupted possession between Ceremonies.

**Personal Topic Note**:
A short, expiring recollection of a member's own ordinary interests, projects or preferences.
The member can inspect or forget it independently of the operational Ceremony history.

**Memory Scope**:
The conversational destinations in which a Personal Topic Note may be recalled, limited by
its source audience, the server's policy and the member's narrower preference.

**Admin Portal**:
The web surface through which a Bot Admin observes and steers the bot: what the Ceremony is doing,
when the next one falls, and what the bot is saying to itself as it works. It is the same authority
as the slash commands wearing a different coat, never a second set of rules, and it holds no power
the Discord surface does not.
_Avoid_: Dashboard (implies watching only), admin panel, control panel

**Bootstrap Configuration**:
The behaviour settings the bot is first given, before anyone has changed anything. It is the
starting point a configuration can always be returned to, and it does not change because someone
later edits the file it came from.
_Avoid_: Default config (the schema's own defaults are a different thing)
