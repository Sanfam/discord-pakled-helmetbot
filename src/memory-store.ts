import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type MemoryScope = "channel" | "category";
export type Provenance = { channelId: string; categoryId: string | null; audience: string; ordinary: boolean };
export type MemoryControl = { disabled: boolean; scope: MemoryScope | null; generation: number; cutoff: number; learnedThrough: number };
export type TopicNote = {
  id: string; guildId: string; memberId: string; tag: string; summary: string;
  source: Provenance; sourceMessageId: string; createdAt: number; reaffirmedAt: number;
  expiresAt: number; lastUsedAt: number | null;
};
export type MemoryAction = { kind: "clear" | "disable" | "enable"; clear?: boolean } |
  { kind: "scope"; scope: MemoryScope } | { kind: "forget"; id: string; wholeTopic: boolean };
export type NoteChange = { kind: "upsert" | "remove"; targetId?: string; tag: string; summary: string;
  at?: number; messageId?: string };
export type MemoryStore = {
  memoryStats(guildId: string, now: number, retentionDays: number): { stored: number; active: number; members: number; disabled: number };
  memoryControl(guildId: string, memberId: string): MemoryControl;
  memoryNotes(guildId: string, memberId: string, now: number, retentionDays: number): TopicNote[];
  controlMemory(guildId: string, memberId: string, action: MemoryAction, now: number): number;
  writeMemory(args: { guildId: string; memberId: string; generation: number; source: Provenance;
    messageId: string; at: number; now: number; retentionDays: number; maxNotes: number; changes: NoteChange[] }): boolean;
  sweepMemory(now: number, retentionDays: number): number;
  markMemoryUsed(guildId: string, ids: string[], now: number): void;
};

export const memoryStore = (db: DatabaseSync): MemoryStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_controls (
    guild_id TEXT NOT NULL, member_id TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
    scope TEXT, generation INTEGER NOT NULL DEFAULT 0, cutoff INTEGER NOT NULL DEFAULT 0, learned_through INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(guild_id, member_id)) STRICT;
    CREATE TABLE IF NOT EXISTS topic_notes (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, member_id TEXT NOT NULL,
    tag TEXT NOT NULL CHECK(length(tag) BETWEEN 1 AND 64),
    summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 320),
    provenance TEXT NOT NULL, source_message_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    reaffirmed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER) STRICT;
    CREATE INDEX IF NOT EXISTS topics_by_member ON topic_notes(guild_id, member_id);`);
  if (!db.prepare("PRAGMA table_info(memory_controls)").all().some((r) => r.name === "learned_through")) {
    db.exec("ALTER TABLE memory_controls ADD COLUMN learned_through INTEGER NOT NULL DEFAULT 0");
  }
  const transaction = <T>(work: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const control: MemoryStore["memoryControl"] = (guild, member) => {
    const row = db.prepare("SELECT * FROM memory_controls WHERE guild_id=? AND member_id=?").get(guild, member);
    return row ? { disabled: row.disabled === 1, scope: row.scope as MemoryScope | null,
      generation: Number(row.generation), cutoff: Number(row.cutoff), learnedThrough: Number(row.learned_through) }
      : { disabled: false, scope: null, generation: 0, cutoff: 0, learnedThrough: 0 };
  };
  const notes: MemoryStore["memoryNotes"] = (guild, member, now, days) =>
    db.prepare(`SELECT * FROM topic_notes WHERE guild_id=? AND member_id=? AND expires_at>? AND reaffirmed_at>?
      ORDER BY reaffirmed_at DESC, id`).all(guild, member, now, now - days * 86400000).map((r) => ({
      id: String(r.id), guildId: String(r.guild_id), memberId: String(r.member_id), tag: String(r.tag), summary: String(r.summary),
      source: JSON.parse(String(r.provenance)) as Provenance, sourceMessageId: String(r.source_message_id),
      createdAt: Number(r.created_at), reaffirmedAt: Number(r.reaffirmed_at),
      expiresAt: Math.min(Number(r.expires_at), Number(r.reaffirmed_at) + days * 86400000),
      lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
    }));
  return {
    memoryStats: (guild, now, days) => {
      const row = db.prepare(`SELECT COUNT(*) AS stored,
        COUNT(CASE WHEN expires_at>? AND reaffirmed_at>? THEN 1 END) AS active,
        COUNT(DISTINCT member_id) AS members FROM topic_notes WHERE guild_id=?`).get(now, now - days * 86400000, guild)!;
      const controls = db.prepare("SELECT COUNT(*) AS disabled FROM memory_controls WHERE guild_id=? AND disabled=1").get(guild)!;
      return { stored: Number(row.stored), active: Number(row.active), members: Number(row.members), disabled: Number(controls.disabled) };
    },
    memoryControl: control,
    memoryNotes: notes,
    controlMemory: (guild, member, action, now) => transaction(() => {
      db.prepare("INSERT OR IGNORE INTO memory_controls(guild_id,member_id) VALUES (?,?)").run(guild, member);
      // Even a one-note forget invalidates all old work/context for this member.
      db.prepare("UPDATE memory_controls SET generation=generation+1, cutoff=MAX(cutoff,?) WHERE guild_id=? AND member_id=?").run(now, guild, member);
      let deleted = 0;
      if (action.kind === "clear" || (action.kind === "disable" && action.clear)) {
        deleted = Number(db.prepare("DELETE FROM topic_notes WHERE guild_id=? AND member_id=?").run(guild, member).changes);
      }
      if (action.kind === "forget") {
        const note = db.prepare("SELECT tag FROM topic_notes WHERE id=? AND guild_id=? AND member_id=?").get(action.id, guild, member);
        if (note) deleted = Number((action.wholeTopic
          ? db.prepare("DELETE FROM topic_notes WHERE guild_id=? AND member_id=? AND tag=?").run(guild, member, note.tag!)
          : db.prepare("DELETE FROM topic_notes WHERE guild_id=? AND member_id=? AND id=?").run(guild, member, action.id)).changes);
      }
      if (action.kind === "enable" || action.kind === "disable") db.prepare("UPDATE memory_controls SET disabled=? WHERE guild_id=? AND member_id=?").run(action.kind === "disable" ? 1 : 0, guild, member);
      if (action.kind === "scope") db.prepare("UPDATE memory_controls SET scope=? WHERE guild_id=? AND member_id=?").run(action.scope, guild, member);
      return deleted;
    }),
    writeMemory: (a) => transaction(() => {
      const current = control(a.guildId, a.memberId);
      const evidenceCutoff = Math.max(current.cutoff, current.learnedThrough);
      if (current.disabled || current.generation !== a.generation || a.at <= evidenceCutoff || a.at > a.now || a.at + a.retentionDays * 86400000 <= a.now) return false;
      // One generation per accepted extraction prevents older jobs overwriting corrections.
      const existing = notes(a.guildId, a.memberId, a.now, a.retentionDays);
      if (existing.some((n) => n.sourceMessageId === a.messageId)) return false;
      const touched = new Set<string>();
      let mutated = false;
      for (const change of [...a.changes].sort((x, y) => (y.at ?? a.at) - (x.at ?? a.at)).slice(0, 5)) {
        const at = change.at ?? a.at;
        const messageId = change.messageId ?? a.messageId;
        if (at <= evidenceCutoff || at > a.now || at + a.retentionDays * 86400000 <= a.now) continue;
        const target = change.targetId === undefined ? undefined : existing.find((n) => n.id === change.targetId);
        if (change.targetId !== undefined && !target) continue;
        if (target && (target.reaffirmedAt >= at || target.source.channelId !== a.source.channelId || JSON.stringify(target.source) !== JSON.stringify(a.source))) continue;
        const tag = change.tag.trim().toLocaleLowerCase();
        if (touched.has(tag) || (target && touched.has(target.tag))) continue;
        touched.add(tag); if (target) touched.add(target.tag);
        if (change.kind === "remove") {
          if (target) mutated = Number(db.prepare("DELETE FROM topic_notes WHERE id=? AND guild_id=? AND member_id=?").run(target.id, a.guildId, a.memberId).changes) > 0 || mutated;
          continue;
        }
        const summary = change.summary.trim();
        if (!tag || tag.length > 64 || !summary || summary.length > 320) continue;
        const same = target ?? existing.find((n) => n.tag === tag && JSON.stringify(n.source) === JSON.stringify(a.source));
        if (same && same.reaffirmedAt >= at) continue;
        db.prepare(`INSERT INTO topic_notes VALUES (?,?,?,?,?,?,?,?,?,?,NULL)
          ON CONFLICT(id) DO UPDATE SET tag=excluded.tag, summary=excluded.summary,
          source_message_id=excluded.source_message_id, reaffirmed_at=excluded.reaffirmed_at, expires_at=excluded.expires_at, last_used_at=NULL`)
          .run(same?.id ?? randomUUID(), a.guildId, a.memberId, tag, summary, JSON.stringify(a.source), messageId,
            same?.createdAt ?? at, at, at + a.retentionDays * 86400000);
        mutated = true;
      }
      mutated = Number(db.prepare(`DELETE FROM topic_notes WHERE guild_id=? AND member_id=? AND id NOT IN
        (SELECT id FROM topic_notes WHERE guild_id=? AND member_id=? ORDER BY reaffirmed_at DESC,id LIMIT ?)`)
        .run(a.guildId, a.memberId, a.guildId, a.memberId, a.maxNotes).changes) > 0 || mutated;
      db.prepare("INSERT OR IGNORE INTO memory_controls(guild_id,member_id) VALUES (?,?)").run(a.guildId, a.memberId);
      db.prepare("UPDATE memory_controls SET generation=generation+?, learned_through=MAX(learned_through,?) WHERE guild_id=? AND member_id=?").run(mutated ? 1 : 0, a.at, a.guildId, a.memberId);
      return true;
    }),
    sweepMemory: (now, days) => transaction(() => {
      db.prepare("UPDATE topic_notes SET expires_at=MIN(expires_at,reaffirmed_at+?)").run(days * 86400000);
      return Number(db.prepare("DELETE FROM topic_notes WHERE expires_at<=?").run(now).changes);
    }),
    markMemoryUsed: (guild, ids, now) => {
      for (const id of ids) db.prepare("UPDATE topic_notes SET last_used_at=? WHERE guild_id=? AND id=?").run(now, guild, id);
    },
  };
};
