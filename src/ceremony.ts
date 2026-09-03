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
