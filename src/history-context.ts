import type { Guild, GuildMember } from "discord.js";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import { historicalFacts } from "./history.ts";
import type { Assignment } from "./ceremony.ts";

/** IDs stay here; the voice receives only bounded, resolved factual statements. */
export const requestedHelmet = (config: Config, question: string): Config["helmets"][number] | null | undefined => {
  const matches = config.helmets.filter((h) => question.toLocaleLowerCase().includes(h.name.toLocaleLowerCase()));
  if (!matches.length && !/helmet|barrel|leader|\b(?:wear|wore|wearing|reign|assignment)\b|\bhow (?:long|many times) (?:have|has|had|did)\b.*\b(?:it|one)\b|\bwho (?:had|held) it\b/i.test(question)) return undefined;
  return matches.length > 1 ? null : matches[0] ?? config.helmets.reduce((a, b) => a.rank > b.rank ? a : b);
};

export const historyContext = async (guild: Guild, store: Store, helmetId: string, subjects: string[], now: number, helmetName = "Biggest Helmet"): Promise<string> => {
  try {
    const members = new Map<string, Promise<GuildMember | null>>();
    const member = (id: string | null): Promise<GuildMember | null> => {
      if (id === null) return Promise.resolve(null);
      if (!members.has(id)) members.set(id, guild.members.fetch({ user: id, force: true }).catch(() => null));
      return members.get(id)!;
    };
    const name = async (id: string | null): Promise<string | null> => (await member(id))?.displayName ?? null;
    const ids = [...new Set(subjects)].slice(0, 3);
    const names = await Promise.all(ids.map(name));
    if (names.some((n, i) => n !== null && names.indexOf(n) !== i)) {
      return "Several supplied members have the same display name. Ask for an unambiguous subject rather than guessing which facts belong to whom.";
    }
    const lines = [];
    for (const [i, id] of ids.entries()) {
      const facts = store.helmetHistory(guild.id, helmetId, id, now);
      const subject = names[i]!;
      if (subject === null) { lines.push("The explicitly identified member could not be resolved. Ask for clarification."); continue; }
      const current = await member(facts.currentHolderId);
      const roleId = store.helmetRoles(guild.id).find((h) => h.helmetId === helmetId)?.roleId;
      if (current && roleId && !current.roles.cache.has(roleId)) {
        facts.runStartedAt = null; facts.runDurationMs = null;
        lines.push(`The last recorded holder no longer wears ${helmetName} in observed Discord state. Current possession is unknown; do not describe an ongoing run.`);
      }
      lines.push(historicalFacts(facts, subject, current?.displayName ?? null, await name(facts.previousHolderId)));
    }
    return [`Recorded ${helmetName} assignments, not proof of uninterrupted Discord role possession. The first member is the asker; subsequent members were explicitly mentioned. Names alone never identify the subject of a question; ask when ambiguous.`, ...lines].join("\n").slice(0, 2000);
  } catch { return ""; }
};

const durationBreakdown = (durationMs: number): string => {
  let remaining = durationMs;
  const days = Math.floor(remaining / 86_400_000); remaining %= 86_400_000;
  const hours = Math.floor(remaining / 3_600_000); remaining %= 3_600_000;
  const minutes = Math.floor(remaining / 60_000); remaining %= 60_000;
  const seconds = Math.floor(remaining / 1_000); remaining %= 1_000;
  const unit = (count: number, singular: string): string => `${count} ${singular}${count === 1 ? "" : "s"}`;
  return [unit(days, "day"), unit(hours, "hour"), unit(minutes, "minute"), unit(seconds, "second"), `${remaining} ms`].join(", ");
};

const safeLabel = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100) || "unnamed member";
const boundedReply = (value: string): string => value.slice(0, 1900);
const unknownDuration = (subject: string, helmetName: string, reason: string): string =>
  boundedReply(`The recorded ${safeLabel(helmetName)} assignment run for ${safeLabel(subject)} is unknown: ${reason}`);

export const historyDurationReply = async (
  guild: Guild,
  store: Store,
  helmetId: string,
  subjectId: string,
  now: number,
  helmetName = "Biggest Helmet",
): Promise<string> => {
  const members = new Map<string, Promise<GuildMember | null>>();
  const resolveMember = (id: string): Promise<GuildMember | null> => {
    if (!members.has(id)) members.set(id, guild.members.fetch({ user: id, force: true }).catch(() => null));
    return members.get(id)!;
  };
  let subject: GuildMember | null;
  let facts: ReturnType<Store["helmetHistory"]>;
  try {
    subject = await resolveMember(subjectId);
  } catch {
    return "The explicitly identified member could not be resolved. Ask for clarification.";
  }
  if (subject === null) return "The explicitly identified member could not be resolved. Ask for clarification.";
  try {
    facts = store.helmetHistory(guild.id, helmetId, subjectId, now);
  } catch {
    return unknownDuration(subject.displayName, helmetName, "the recorded history could not be read");
  }

  const subjectName = safeLabel(subject.displayName);
  if (facts.currentHolderId !== subjectId) {
    return boundedReply(`No current recorded run for ${subjectName} with ${safeLabel(helmetName)} is available; its duration is unknown.`);
  }

  const currentHolder = await resolveMember(facts.currentHolderId);
  if (currentHolder === null) return unknownDuration(subjectName, helmetName, "the recorded current holder could not be resolved");

  let roleId: string | undefined;
  try { roleId = store.helmetRoles(guild.id).find((role) => role.helmetId === helmetId)?.roleId; } catch { /* handled below */ }
  if (roleId === undefined) return unknownDuration(subjectName, helmetName, "the helmet role is not recorded");
  try {
    if (!currentHolder.roles.cache.has(roleId)) {
      return unknownDuration(subjectName, helmetName, `Discord does not show the recorded holder with the ${safeLabel(helmetName)} role`);
    }
  } catch {
    return unknownDuration(subjectName, helmetName, "Discord role observation is unavailable");
  }

  const durationMs = facts.runDurationMs;
  if (facts.runStartedAt === null || !Number.isSafeInteger(facts.runStartedAt) || facts.runStartedAt > now || durationMs === null || !Number.isSafeInteger(durationMs) || durationMs < 0) {
    return unknownDuration(subjectName, helmetName, "no valid recorded duration is available");
  }
  return boundedReply(`Recorded ${safeLabel(helmetName)} assignment run for ${subjectName}: ${durationBreakdown(durationMs)}. This describes recorded assignments, not proof of uninterrupted Discord role possession.`);
};

/** Called only after Discord verification, with the new result still transient. */
export const aftermathMemory = (args: {
  store: Store; guildId: string; config: Config; assignments: Assignment[]; names: Map<string, string>; now: number;
}): string => {
  try {
    const helmets = [...args.config.helmets].sort((a, b) => b.rank - a.rank);
    for (const helmet of helmets) {
      const assignment = args.assignments.find((a) => a.helmetId === helmet.id);
      if (!assignment) continue;
      const name = args.names.get(assignment.memberId);
      if (!name) continue;
      const prior = args.store.helmetHistory(args.guildId, helmet.id, assignment.memberId, args.now);
      if (prior.currentHolderId === assignment.memberId) return `${name} received ${helmet.name} in the previous successful ceremony and again in this verified outcome. This is an assignment repeat, not proof of continuous possession.`;
      if (helmet === helmets[0] && prior.assignments > 0) return `${name} has returned to ${helmet.name}: ${prior.assignments} prior recorded assignments, plus this verified outcome.`;
    }
    const biggest = helmets[0]!;
    const current = args.assignments.find((a) => a.helmetId === biggest.id);
    if (!current) return "";
    const prior = args.store.helmetHistory(args.guildId, biggest.id, current.memberId, args.now);
    const previousName = prior.currentHolderId === null ? null : args.names.get(prior.currentHolderId);
    if (previousName && prior.runDurationMs !== null && prior.runDurationMs >= 7 * 86400000) {
      return `${previousName}'s recorded run of ${biggest.name} assignments began ${new Date(prior.runStartedAt!).toISOString()}; the verified outcome now assigns it to ${args.names.get(current.memberId) ?? "another member"}. This is not proof of uninterrupted possession.`;
    }
    return "";
  } catch { return ""; }
};
