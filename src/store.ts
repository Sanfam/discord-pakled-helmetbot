import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Assignment, CeremonyState } from "./ceremony.ts";
import type { StoredHelmetRole } from "./helmets.ts";
import type { Schedule } from "./schedule.ts";

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

/** Thrown when a Ceremony is already in flight for the guild. */
export class CeremonyInFlightError extends Error {}

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
  recordPreviousHolders(ceremonyId: string, holders: Map<string, string[]>): void;
  previousHolders(ceremonyId: string): Map<string, string[]>;
  /** A ceremony that began and has neither completed nor failed. */
  inFlightCeremony(guildId: string): CeremonyRecord | undefined;

  recordChannelMessage(guildId: string, channelId: string, at: number): void;
  recordBotMessage(guildId: string, channelId: string, at: number): void;
  channelActivity(guildId: string): { channelId: string; lastMessageAt: number; lastBotMessageAt: number | null }[];

  /** Whoever the last completed, non-dry-run Ceremony assigned the given helmet to. */
  currentHolderOf(guildId: string, helmetId: string): string | undefined;

  /** Survives restart, so a redeploy never triggers a Ceremony. */
  schedule(guildId: string): Schedule;
  saveSchedule(guildId: string, schedule: Schedule): void;

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

  -- One unfinished ceremony per guild, enforced by the database rather than by a
  -- check-then-insert that two processes can both pass.
  CREATE UNIQUE INDEX IF NOT EXISTS one_ceremony_in_flight
    ON ceremonies (guild_id) WHERE completed_at IS NULL;

  CREATE TABLE IF NOT EXISTS ceremony_transitions (
    ceremony_id TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    state       TEXT NOT NULL,
    at          TEXT NOT NULL,
    PRIMARY KEY (ceremony_id, seq)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS channel_activity (
    guild_id           TEXT NOT NULL,
    channel_id         TEXT NOT NULL,
    last_message_at    INTEGER NOT NULL,
    last_bot_message_at INTEGER,
    PRIMARY KEY (guild_id, channel_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS guild_state (
    guild_id             TEXT PRIMARY KEY,
    next_ceremony_at     INTEGER,
    paused               INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE TABLE IF NOT EXISTS ceremony_previous_holders (
    ceremony_id TEXT NOT NULL,
    helmet_id   TEXT NOT NULL,
    member_id   TEXT NOT NULL,
    PRIMARY KEY (ceremony_id, helmet_id, member_id)
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

  const insertPrevious = db.prepare(
    "INSERT OR IGNORE INTO ceremony_previous_holders (ceremony_id, helmet_id, member_id) VALUES (?, ?, ?)",
  );
  const selectPrevious = db.prepare(
    "SELECT helmet_id, member_id FROM ceremony_previous_holders WHERE ceremony_id = ?",
  );
  const selectInFlight = db.prepare(
    "SELECT * FROM ceremonies WHERE guild_id = ? AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1",
  );

  const touchChannel = db.prepare(
    `INSERT INTO channel_activity (guild_id, channel_id, last_message_at) VALUES (?, ?, ?)
     ON CONFLICT (guild_id, channel_id) DO UPDATE SET last_message_at = excluded.last_message_at`,
  );
  const touchBot = db.prepare(
    `INSERT INTO channel_activity (guild_id, channel_id, last_message_at, last_bot_message_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, channel_id) DO UPDATE SET last_bot_message_at = excluded.last_bot_message_at`,
  );
  const selectChannelActivity = db.prepare("SELECT * FROM channel_activity WHERE guild_id = ?");

  const selectCurrentHolder = db.prepare(
    `SELECT a.member_id FROM helmet_assignments a
       JOIN ceremonies c ON c.id = a.ceremony_id
      WHERE c.guild_id = ? AND c.status = 'COMPLETE' AND c.dry_run = 0 AND a.helmet_id = ?
      ORDER BY c.completed_at DESC LIMIT 1`,
  );

  const selectSchedule = db.prepare("SELECT * FROM guild_state WHERE guild_id = ?");
  const upsertSchedule = db.prepare(
    `INSERT INTO guild_state (guild_id, next_ceremony_at, paused, consecutive_failures) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET
       next_ceremony_at = excluded.next_ceremony_at,
       paused = excluded.paused,
       consecutive_failures = excluded.consecutive_failures`,
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
      try {
        insertCeremony.run(id, guildId, now, "IDLE", dryRun ? 1 : 0);
      } catch (cause) {
        if (/UNIQUE constraint failed/i.test((cause as Error).message)) {
          throw new CeremonyInFlightError("a ceremony is already in flight for this guild");
        }
        throw cause;
      }
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

    recordChannelMessage: (guildId, channelId, at) => void touchChannel.run(guildId, channelId, at),
    recordBotMessage: (guildId, channelId, at) => void touchBot.run(guildId, channelId, at, at),
    channelActivity: (guildId) =>
      selectChannelActivity.all(guildId).map((r) => ({
        channelId: r.channel_id as string,
        lastMessageAt: r.last_message_at as number,
        lastBotMessageAt: (r.last_bot_message_at as number | null) ?? null,
      })),

    currentHolderOf: (guildId, helmetId) => {
      const row = selectCurrentHolder.get(guildId, helmetId);
      return row === undefined ? undefined : (row.member_id as string);
    },

    schedule: (guildId) => {
      const row = selectSchedule.get(guildId);
      if (row === undefined) return { nextCeremonyAt: null, paused: false, consecutiveFailures: 0 };
      return {
        nextCeremonyAt: (row.next_ceremony_at as number | null) ?? null,
        paused: row.paused === 1,
        consecutiveFailures: row.consecutive_failures as number,
      };
    },
    saveSchedule: (guildId, schedule) => {
      upsertSchedule.run(guildId, schedule.nextCeremonyAt, schedule.paused ? 1 : 0, schedule.consecutiveFailures);
    },

    recordPreviousHolders: (ceremonyId, holders) => {
      for (const [helmetId, memberIds] of holders) {
        for (const memberId of memberIds) insertPrevious.run(ceremonyId, helmetId, memberId);
      }
    },
    previousHolders: (ceremonyId) => {
      const holders = new Map<string, string[]>();
      for (const row of selectPrevious.all(ceremonyId)) {
        const helmetId = row.helmet_id as string;
        holders.set(helmetId, [...(holders.get(helmetId) ?? []), row.member_id as string]);
      }
      return holders;
    },
    inFlightCeremony: (guildId) => {
      const row = selectInFlight.get(guildId);
      return row === undefined ? undefined : toCeremony(row);
    },

    close: () => db.close(),
  };
};
