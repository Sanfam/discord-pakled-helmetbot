# The bot garbage-collects its own helmet roles

`config.yaml` is authoritative over the helmet set. When a helmet is removed from config, the bot
deletes the corresponding Discord role rather than abandoning it — it owns these roles and is
responsible for cleaning them up, and orphaned helmets nobody can win are worse than a clean
deletion.

## Consequences

Role deletion is destructive and strips the role from every member holding it, so it is scoped
strictly to roles the bot provisioned itself and recorded the ID for in SQLite. A role that merely
matches a helmet name is never touched, preserving §33's rule that no unmanaged role is modified.
Editing `config.yaml` is therefore a destructive operation and should be treated like one.
