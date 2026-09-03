import { randomInt } from "node:crypto";
import type { Helmet } from "./config.ts";

/**
 * Ceremony planning: who receives which helmet. Pure over its inputs and over an
 * injected random source, so a seeded plan is reproducible in tests. Injection
 * exists for testability, not so that a past Ceremony can be replayed.
 *
 * This module decides nothing about Discord and performs no effects. Applying a
 * plan, and rolling it back, belongs to the ticket after this one.
 */

export const CEREMONY_STATES = [
  "IDLE",
  "EPIPHANY",
  "SUMMON",
  "COLLECTION",
  "BARREL",
  "REDISTRIBUTION",
  "AFTERMATH",
  "COMPLETE",
  "FAILED",
] as const;
export type CeremonyState = (typeof CEREMONY_STATES)[number];

/**
 * The states a plan-only Ceremony passes through. It stops at the barrel: nothing
 * is redistributed, so recording REDISTRIBUTION would be a lie. Those states arrive
 * with the ticket that applies a plan.
 */
export const PLANNING_STATES = ["EPIPHANY", "SUMMON", "COLLECTION", "BARREL", "COMPLETE"] as const satisfies readonly CeremonyState[];

export type Member = {
  id: string;
  displayName: string;
  username: string;
  isBot: boolean;
  roleIds: string[];
  highestRolePosition: number;
};

export type EligibilityRules = {
  /** The bot's own user id. Always an Eligible Member, per ADR-0001. */
  pakledId: string;
  excludedUserIds: string[];
  excludedRoleIds: string[];
  /** Discord refuses to let the bot manage a member whose highest role is at or above its own. */
  botHighestRolePosition: number;
};

export type Random = { int: (maxExclusive: number) => number };

export type Assignment = { helmetId: string; memberId: string };
export type CeremonyPlan = {
  assignments: Assignment[];
  /** Helmets nobody received. They stay in the Great Helmet Barrel. */
  leftoverHelmetIds: string[];
};

/** Cryptographically strong, which costs nothing here over the alternative. */
export const cryptoRandom: Random = { int: (maxExclusive) => randomInt(maxExclusive) };

/** Deterministic source for tests: mulberry32. */
export const seededRandom = (seed: number): Random => {
  let state = seed >>> 0;
  return {
    int: (maxExclusive) => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * maxExclusive | 0;
    },
  };
};

const shuffled = <T>(items: readonly T[], random: Random): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = random.int(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

export const eligibleMembers = (members: Member[], rules: EligibilityRules): Member[] => {
  const excludedUsers = new Set(rules.excludedUserIds);
  const excludedRoles = new Set(rules.excludedRoleIds);

  return members.filter((member) => {
    // The Pakled is an Eligible Member whatever else is true of it: it is a bot,
    // and its own role sits above every helmet by design (ADR-0001).
    if (member.id === rules.pakledId) return true;
    if (member.isBot) return false;
    if (excludedUsers.has(member.id)) return false;
    if (member.roleIds.some((roleId) => excludedRoles.has(roleId))) return false;
    return member.highestRolePosition < rules.botHighestRolePosition;
  });
};

/**
 * Labels for members, disambiguated only where they need to be. Two accounts can
 * share a display name, and a Ceremony report that lists the same name twice reads
 * as a bug that is not there.
 */
export const memberLabels = (members: Member[]): Map<string, string> => {
  const seen = new Map<string, number>();
  for (const m of members) seen.set(m.displayName, (seen.get(m.displayName) ?? 0) + 1);
  return new Map(
    members.map((m) => [m.id, (seen.get(m.displayName) ?? 0) > 1 ? `${m.displayName} (@${m.username})` : m.displayName]),
  );
};

export type EligibilitySummary = {
  eligible: number;
  otherBots: number;
  excludedByConfig: number;
  /** Members whose own highest role sits at or above the bot's, so Discord will not let it assign to them. */
  aboveTheBot: number;
};

/** Why members were left out, so an operator is never left guessing. */
export const summariseEligibility = (members: Member[], rules: EligibilityRules): EligibilitySummary => {
  const excludedUsers = new Set(rules.excludedUserIds);
  const excludedRoles = new Set(rules.excludedRoleIds);
  const summary: EligibilitySummary = { eligible: 0, otherBots: 0, excludedByConfig: 0, aboveTheBot: 0 };

  for (const member of members) {
    if (member.id === rules.pakledId) summary.eligible++;
    else if (member.isBot) summary.otherBots++;
    else if (excludedUsers.has(member.id) || member.roleIds.some((r) => excludedRoles.has(r))) summary.excludedByConfig++;
    else if (member.highestRolePosition >= rules.botHighestRolePosition) summary.aboveTheBot++;
    else summary.eligible++;
  }
  return summary;
};

export const planCeremony = (
  helmets: Helmet[],
  eligible: Member[],
  pakledId: string,
  random: Random,
): CeremonyPlan => {
  const pakled = eligible.find((m) => m.id === pakledId);
  const others = shuffled(eligible.filter((m) => m.id !== pakledId), random);

  // The Pakled takes a helmet out of the barrel it is holding: a guaranteed slot,
  // but a random helmet, so it can draw The Biggest Helmet and be suspicious of it.
  const recipients = pakled === undefined ? others : [pakled, ...others];
  const order = shuffled(helmets, random);
  const count = Math.min(order.length, recipients.length);

  // The one invariant that must always hold: The Biggest Helmet is always assigned,
  // never left in the barrel, even when there are fewer people than helmets.
  const biggestId = helmets.reduce((a, b) => (b.rank > a.rank ? b : a)).id;
  const biggestAt = order.findIndex((h) => h.id === biggestId);
  if (count > 0 && biggestAt >= count) {
    const swapWith = random.int(count);
    [order[biggestAt], order[swapWith]] = [order[swapWith]!, order[biggestAt]!];
  }

  return {
    assignments: order.slice(0, count).map((helmet, i) => ({ helmetId: helmet.id, memberId: recipients[i]!.id })),
    leftoverHelmetIds: order.slice(count).map((helmet) => helmet.id),
  };
};

/* ── Applying a plan ─────────────────────────────────────────────────────────
 *
 * Discord role changes are not a transaction, so this performs a compensating
 * one: each mutation is logged once its call resolves, and a failure replays that
 * log backwards to put the guild back the way it was found.
 *
 * The log records what we know landed, which is not identical to what landed: a
 * call whose response is lost may have taken effect in Discord without being
 * logged, and rollback cannot compensate for what it cannot see. Rollback is
 * best-effort by nature, not a transaction.
 */

export type CeremonyEffects = {
  addRole(memberId: string, roleId: string): Promise<void>;
  removeRole(memberId: string, roleId: string): Promise<void>;
};

/** helmetId -> the members currently wearing it. */
export type HolderMap = Map<string, string[]>;

export type ApplyOutcome =
  | { status: "COMPLETE"; mutations: number }
  | { status: "FAILED"; reason: string; rolledBack: boolean; rollbackError?: string };

/**
 * The helmet -> role mapping a Ceremony may act on: stored rows intersected with
 * the configured Helmet Set. A stale stored row pointing at some unrelated role
 * must never reach a mutation, so the boundary is enforced here rather than being
 * assumed to have been cleaned up by reconciliation.
 */
export const helmetRoleMap = (helmets: Helmet[], stored: { helmetId: string; roleId: string }[]): Map<string, string> => {
  const configured = new Set(helmets.map((h) => h.id));
  return new Map(stored.filter((row) => configured.has(row.helmetId)).map((row) => [row.helmetId, row.roleId]));
};

export const holdersOf = (members: Member[], roleByHelmet: Map<string, string>): HolderMap => {
  const holders: HolderMap = new Map([...roleByHelmet.keys()].map((helmetId) => [helmetId, []]));
  for (const member of members) {
    for (const [helmetId, roleId] of roleByHelmet) {
      if (member.roleIds.includes(roleId)) holders.get(helmetId)!.push(member.id);
    }
  }
  return holders;
};

type Mutation = { op: "add" | "remove"; memberId: string; roleId: string };

export const applyCeremony = async (args: {
  plan: CeremonyPlan;
  roleByHelmet: Map<string, string>;
  biggestHelmetId: string;
  previousHolders: HolderMap;
  effects: CeremonyEffects;
  /** Re-read holders for exactly these members. Scoped deliberately: fetching the
   *  whole guild costs a gateway member request, which is rate limited per guild
   *  and will fail a Ceremony that is otherwise perfectly correct. */
  readHolders: (memberIds: string[]) => Promise<HolderMap>;
  onState: (state: CeremonyState) => void;
}): Promise<ApplyOutcome> => {
  const { plan, roleByHelmet, biggestHelmetId, previousHolders, effects, readHolders, onState } = args;
  const applied: Mutation[] = [];

  const perform = async (op: "add" | "remove", memberId: string, roleId: string) => {
    if (op === "add") await effects.addRole(memberId, roleId);
    else await effects.removeRole(memberId, roleId);
    applied.push({ op, memberId, roleId });
  };

  // Every remaining compensation is still attempted after one fails: abandoning
  // the rest leaves the guild worse off than it needs to be (specification §26).
  const rollback = async (): Promise<string[]> => {
    const errors: string[] = [];
    for (const mutation of [...applied].reverse()) {
      try {
        if (mutation.op === "add") await effects.removeRole(mutation.memberId, mutation.roleId);
        else await effects.addRole(mutation.memberId, mutation.roleId);
      } catch (cause) {
        errors.push(`${mutation.op} ${mutation.memberId}: ${(cause as Error).message}`);
      }
    }
    return errors;
  };

  const fail = async (reason: string): Promise<ApplyOutcome> => {
    const errors = await rollback();
    onState("FAILED");
    return errors.length === 0
      ? { status: "FAILED", reason, rolledBack: true }
      : { status: "FAILED", reason, rolledBack: false, rollbackError: errors.join("; ") };
  };

  try {
    // A member wearing two helmets breaks the ownership model, and it is cheaper to
    // refuse the plan than to detect it after twenty role mutations have landed.
    const recipients = plan.assignments.map((a) => a.memberId);
    if (new Set(recipients).size !== recipients.length) {
      onState("FAILED");
      return { status: "FAILED", reason: "plan assigns more than one helmet to the same member", rolledBack: true };
    }

    onState("EPIPHANY");
    onState("SUMMON");

    onState("COLLECTION");
    for (const [helmetId, memberIds] of previousHolders) {
      const roleId = roleByHelmet.get(helmetId);
      if (roleId === undefined) continue;
      for (const memberId of memberIds) await perform("remove", memberId, roleId);
    }

    onState("BARREL");

    onState("REDISTRIBUTION");
    for (const assignment of plan.assignments) {
      const roleId = roleByHelmet.get(assignment.helmetId);
      if (roleId === undefined) continue;
      await perform("add", assignment.memberId, roleId);
    }

    onState("AFTERMATH");
    // Everyone the Ceremony could have changed: whoever held a helmet before, and
    // whoever was meant to receive one.
    const affected = [
      ...new Set([...[...previousHolders.values()].flat(), ...plan.assignments.map((a) => a.memberId)]),
    ];
    const actual = await readHolders(affected);

    // Confirmed by reading Discord back, not assumed from the pairing — but scoped
    // to the members this Ceremony could have touched. A guild-wide check would cost
    // a gateway member request, which is rate limited per guild and would fail
    // correct Ceremonies. Someone granted a helmet by another actor mid-Ceremony is
    // therefore outside what this can see.
    const biggest = actual.get(biggestHelmetId) ?? [];
    if (biggest.length !== 1) {
      return await fail(`The Biggest Helmet is held by ${biggest.length} members after redistribution, expected exactly 1`);
    }
    for (const assignment of plan.assignments) {
      if (!(actual.get(assignment.helmetId) ?? []).includes(assignment.memberId)) {
        return await fail(`${assignment.memberId} did not receive ${assignment.helmetId}`);
      }
    }

    onState("COMPLETE");
    return { status: "COMPLETE", mutations: applied.length };
  } catch (cause) {
    return await fail((cause as Error).message);
  }
};
