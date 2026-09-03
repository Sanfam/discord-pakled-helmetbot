import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Assignment, CeremonyState } from "./ceremony.ts";
import type { StoredHelmetRole } from "./helmets.ts";

/**
 * Persistent state. SQLite ships with Node, so this needs no dependency.
 *
 * Every table is keyed by guild even though the runtime serves exactly one:
 * the schema is the expensive half to retrofit, so it is right from the start
 * while per-guild runtime machinery is not built (ADR-0002).
 */
export type CeremonyRecord = {
  id: string;
  guildId: string;
  startedAt: string;
  completedAt: string | null;
  status: CeremonyState;
  dryRun: boolean;
};

export type Store = {
  helmetRoles(guildId: string): StoredHelmetRole[];
  recordHelmetRole(guildId: string, helmetId: string, roleId: string): void;
  forgetHelmetRole(guildId: string, helmetId: string): void;

  beginCeremony(guildId: string, dryRun: boolean): string;
  recordTransition(ceremonyId: string, state: CeremonyState): void;
  recordAssignments(ceremonyId: string, assignments: Assignment[]): void;
  completeCeremony(ceremonyId: string, status: CeremonyState): void;
  ceremony(ceremonyId: string): CeremonyRecord | undefined;
  ceremonies(guildId: string): CeremonyRecord[];
  ceremonyTransitions(ceremonyId: string): CeremonyState[];
  ceremonyAssignments(ceremonyId: string): Assignment[];

  close(): void;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS helmet_roles (
    guild_id  TEXT NOT NULL,
    helmet_id TEXT NOT NULL,
    role_id   TEXT NOT NULL,
    PRIMARY KEY (guild_id, helmet_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS ceremonies (
    id           TEXT PRIMARY KEY,
    guild_id     TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    completed_at TEXT,
    status       TEXT NOT NULL,
    dry_run      INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS ceremony_transitions (
    ceremony_id TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    state       TEXT NOT NULL,
    at          TEXT NOT NULL,
    PRIMARY KEY (ceremony_id, seq)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS helmet_assignments (
    ceremony_id TEXT NOT NULL,
    helmet_id   TEXT NOT NULL,
    member_id   TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    PRIMARY KEY (ceremony_id, helmet_id)
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

  const insertCeremony = db.prepare(
    "INSERT INTO ceremonies (id, guild_id, started_at, status, dry_run) VALUES (?, ?, ?, ?, ?)",
  );
  const insertTransition = db.prepare(
    `INSERT INTO ceremony_transitions (ceremony_id, seq, state, at)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM ceremony_transitions WHERE ceremony_id = ?), ?, ?)`,
  );
  const insertAssignment = db.prepare(
    "INSERT INTO helmet_assignments (ceremony_id, helmet_id, member_id, seq) VALUES (?, ?, ?, ?)",
  );
  const setStatus = db.prepare("UPDATE ceremonies SET status = ? WHERE id = ?");
  const finishCeremony = db.prepare("UPDATE ceremonies SET status = ?, completed_at = ? WHERE id = ?");
  const selectCeremony = db.prepare("SELECT * FROM ceremonies WHERE id = ?");
  const selectCeremonies = db.prepare("SELECT * FROM ceremonies WHERE guild_id = ? ORDER BY started_at DESC");
  const selectTransitions = db.prepare("SELECT state FROM ceremony_transitions WHERE ceremony_id = ? ORDER BY seq");
  const selectAssignments = db.prepare(
    "SELECT helmet_id, member_id FROM helmet_assignments WHERE ceremony_id = ? ORDER BY seq",
  );

  const toCeremony = (row: Record<string, unknown>): CeremonyRecord => ({
    id: row.id as string,
    guildId: row.guild_id as string,
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
    status: row.status as CeremonyState,
    dryRun: row.dry_run === 1,
  });

  return {
    helmetRoles: (guildId) =>
      select.all(guildId).map((row) => ({
        helmetId: row.helmet_id as string,
        roleId: row.role_id as string,
      })),
    recordHelmetRole: (guildId, helmetId, roleId) => void upsert.run(guildId, helmetId, roleId),
    forgetHelmetRole: (guildId, helmetId) => void remove.run(guildId, helmetId),
    beginCeremony: (guildId, dryRun) => {
      const id = randomUUID();
      const now = new Date().toISOString();
      // Begins IDLE and records no transition: the caller drives the state machine,
      // so the recorded transitions are exactly the states it walked.
      insertCeremony.run(id, guildId, now, "IDLE", dryRun ? 1 : 0);
      return id;
    },
    recordTransition: (ceremonyId, state) => {
      insertTransition.run(ceremonyId, ceremonyId, state, new Date().toISOString());
      setStatus.run(state, ceremonyId);
    },
    recordAssignments: (ceremonyId, assignments) => {
      assignments.forEach((a, i) => insertAssignment.run(ceremonyId, a.helmetId, a.memberId, i));
    },
    completeCeremony: (ceremonyId, status) => {
      finishCeremony.run(status, new Date().toISOString(), ceremonyId);
    },
    ceremony: (ceremonyId) => {
      const row = selectCeremony.get(ceremonyId);
      return row === undefined ? undefined : toCeremony(row);
    },
    ceremonies: (guildId) => selectCeremonies.all(guildId).map(toCeremony),
    ceremonyTransitions: (ceremonyId) => selectTransitions.all(ceremonyId).map((r) => r.state as CeremonyState),
    ceremonyAssignments: (ceremonyId) =>
      selectAssignments.all(ceremonyId).map((r) => ({ helmetId: r.helmet_id as string, memberId: r.member_id as string })),

    close: () => db.close(),
  };
};
