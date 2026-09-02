# Guild-scoped schema, single-guild runtime

Every table is keyed by guild and `guildId` is threaded through function signatures rather than read
from a global, but the running bot serves exactly one guild. Multi-guild support is unlikely but not
foreclosed, and the schema is the expensive half to retrofit while per-guild config, schedulers,
provisioning, and an install flow are work we would be doing today for an event that may never come.

## Consequences

A reader will find `guild_id` on tables in a bot that only ever talks to one server. That is
deliberate: making the system malleable now costs nothing, and the later port is mechanical rather
than a migration.
