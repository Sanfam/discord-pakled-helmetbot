import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredHelmetRole } from "./helmets.ts";

/**
 * Persistent state. SQLite ships with Node, so this needs no dependency.
 *
 * Every table is keyed by guild even though the runtime serves exactly one:
 * the schema is the expensive half to retrofit, so it is right from the start
 * while per-guild runtime machinery is not built (ADR-0002).
 */
export type Store = {
  helmetRoles(guildId: string): StoredHelmetRole[];
  recordHelmetRole(guildId: string, helmetId: string, roleId: string): void;
  forgetHelmetRole(guildId: string, helmetId: string): void;
  close(): void;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS helmet_roles (
    guild_id  TEXT NOT NULL,
    helmet_id TEXT NOT NULL,
    role_id   TEXT NOT NULL,
    PRIMARY KEY (guild_id, helmet_id)
  ) STRICT;
`;

export const openStore = (path: string): Store => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const select = db.prepare("SELECT helmet_id, role_id FROM helmet_roles WHERE guild_id = ?");
  const upsert = db.prepare(
    `INSERT INTO helmet_roles (guild_id, helmet_id, role_id) VALUES (?, ?, ?)
     ON CONFLICT (guild_id, helmet_id) DO UPDATE SET role_id = excluded.role_id`,
  );
  const remove = db.prepare("DELETE FROM helmet_roles WHERE guild_id = ? AND helmet_id = ?");

  return {
    helmetRoles: (guildId) =>
      select.all(guildId).map((row) => ({
        helmetId: row.helmet_id as string,
        roleId: row.role_id as string,
      })),
    recordHelmetRole: (guildId, helmetId, roleId) => void upsert.run(guildId, helmetId, roleId),
    forgetHelmetRole: (guildId, helmetId) => void remove.run(guildId, helmetId),
    close: () => db.close(),
  };
};
