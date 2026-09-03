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
  /**
   * Set when this plan deliberately gives one member two helmets. Declared rather
   * than inferred: a duplicate recipient is still a bug unless the plan says it was
   * meant, so the guard that refuses one keeps protecting against the real thing.
   */
  multihatMemberId?: string;
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

/**
 * How likely a member is to be drawn, from how recently they were last seen.
 *
 * Weighted, never filtered: a dormant member stays eligible, just unlikely. On a
 * quiet server filtering would shrink the pool below the Helmet Set and exclude the
 * same people forever, and the occasional surprise helmet for someone who has been
 * away is good for the bit.
 */
export type ActivityTier = { withinDays: number; weight: number };

export const activityWeight = (
  lastSeenAt: number | null,
  now: number,
  tiers: ActivityTier[],
  dormantWeight: number,
): number => {
  if (lastSeenAt === null) return dormantWeight;
  const ageDays = Math.max(0, now - lastSeenAt) / 86_400_000;
  // Tiers are read most-recent-first, so the tightest matching window wins.
  const match = [...tiers].sort((a, b) => a.withinDays - b.withinDays).find((t) => ageDays <= t.withinDays);
  return match?.weight ?? dormantWeight;
};

/** Draw `count` distinct items, each drawn with probability proportional to weight. */
const MIN_WEIGHT = 1e-6;
/** Wide enough for any sensible configuration, narrow enough that every interval
 *  stays comfortably above the selection lattice. */
const MAX_WEIGHT_RATIO = 1e6;

export const weightedDraw = <T>(items: T[], weightOf: (item: T) => number, count: number, random: Random): T[] => {
  // Clamped to a finite, positive range. A non-finite weight would poison the total
  // with NaN and make every draw fall through to the same fallback entry, and a
  // weight of zero would exclude someone permanently, which this must never do.
  const sane = (value: number): number => (Number.isFinite(value) && value > 0 ? value : MIN_WEIGHT);
  const raw = items.map((item) => ({ item, weight: sane(weightOf(item)) }));

  // Clamp the *spread*, not just the magnitude. Selection lands on a lattice, so a
  // ratio wide enough to make one interval narrower than the lattice would exclude
  // that member outright — and nobody may ever be excluded. Beyond this ratio the
  // difference is unobservable anyway.
  const lightest = Math.min(...raw.map((e) => e.weight));
  const pool = raw.map((e) => ({ item: e.item, weight: Math.min(e.weight, lightest * MAX_WEIGHT_RATIO) }));
  const drawn: T[] = [];

  while (drawn.length < count && pool.length > 0) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
    // random.int gives an integer, so the ticket is scaled rather than fractional.
    // The lattice is fine enough that even the lowest allowed weight keeps an
    // interval wide enough to land in, whatever the ratio between weights.
    let ticket = (random.int(1_000_000_000) / 1_000_000_000) * total;
    let index = pool.length - 1;
    for (const [i, entry] of pool.entries()) {
      ticket -= entry.weight;
      if (ticket < 0) {
        index = i;
        break;
      }
    }
    drawn.push(pool[index]!.item);
    pool.splice(index, 1);
  }

  return drawn;
};

export const planCeremony = (
  helmets: Helmet[],
  eligible: Member[],
  pakledId: string,
  random: Random,
  /** Selection weight per member. Omitted, everyone is equally likely. */
  weightOf: (member: Member) => number = () => 1,
  /** Chance that one member ends up wearing two helmets at once. */
  multihatProbability = 0,
): CeremonyPlan => {
  const pakled = eligible.find((m) => m.id === pakledId);
  // Weighting decides who takes part. Which helmet they then receive stays uniform.
  const others = weightedDraw(
    eligible.filter((m) => m.id !== pakledId),
    weightOf,
    eligible.length,
    random,
  );

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

  const assignments = order
    .slice(0, count)
    .map((helmet, i) => ({ helmetId: helmet.id, memberId: recipients[i]!.id }));

  // The Multihat: rarely, one member ends up wearing two helmets at once, and the
  // Pakled treats them with something close to reverence thereafter.
  //
  // It costs a Helmet Holder — ten helmets over nine people — which is the point.
  // Declared on the plan rather than inferred, so the guard that refuses an
  // accidental duplicate still refuses one; only a Multihat that was meant is let
  // through.
  let multihat: string | undefined;
  const canDouble = count >= 2 && multihatProbability > 0;
  if (canDouble && random.int(1_000_000) / 1_000_000 < multihatProbability) {
    // Whoever loses their place must not be The Pakled: its slot is guaranteed
    // whatever else happens (ADR-0001).
    const droppable = assignments.map((_, i) => i).filter((i) => assignments[i]!.memberId !== pakledId);
    if (droppable.length > 0) {
      const surrendered = droppable[random.int(droppable.length)]!;
      const keepers = assignments.map((_, i) => i).filter((i) => i !== surrendered);
      const blessed = keepers[random.int(keepers.length)]!;
      assignments[surrendered]!.memberId = assignments[blessed]!.memberId;
      multihat = assignments[blessed]!.memberId;
    }
  }

  return {
    assignments,
    leftoverHelmetIds: order.slice(count).map((helmet) => helmet.id),
    ...(multihat === undefined ? {} : { multihatMemberId: multihat }),
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
  /**
   * Narrate a beat, and take as long doing it as the pacing asks. Awaited, so role
   * changes land while the Pakled is still talking about them rather than all at
   * once before anyone notices. Never allowed to fail the Ceremony.
   */
  onBeat?: ((beat: CeremonyState) => Promise<void>) | undefined;
}): Promise<ApplyOutcome> => {
  const { plan, roleByHelmet, biggestHelmetId, previousHolders, effects, readHolders, onState } = args;
  const beat = async (state: CeremonyState): Promise<void> => {
    onState(state);
    if (args.onBeat === undefined) return;
    // A Ceremony must complete even if nothing can be said about it.
    await args.onBeat(state).catch(() => undefined);
  };
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
    //
    // Unless the plan declares a Multihat, and then exactly one member may hold
    // exactly two. Anything beyond that is still the bug this guard was added for.
    const recipients = plan.assignments.map((a) => a.memberId);
    const counts = new Map<string, number>();
    for (const memberId of recipients) counts.set(memberId, (counts.get(memberId) ?? 0) + 1);
    const doubled = [...counts.entries()].filter(([, n]) => n > 1);
    const declared = plan.multihatMemberId;
    // Exactly one declared member with exactly two, or no duplicates and nothing
    // declared. A declaration with no duplicate behind it is also malformed: it
    // would confer reverence on someone wearing one helmet.
    const allowed =
      declared === undefined
        ? doubled.length === 0
        : doubled.length === 1 && doubled[0]![0] === declared && doubled[0]![1] === 2;

    if (!allowed) {
      onState("FAILED");
      return { status: "FAILED", reason: "plan assigns more than one helmet to the same member", rolledBack: true };
    }

    await beat("EPIPHANY");
    await beat("SUMMON");

    await beat("COLLECTION");
    for (const [helmetId, memberIds] of previousHolders) {
      const roleId = roleByHelmet.get(helmetId);
      if (roleId === undefined) continue;
      for (const memberId of memberIds) await perform("remove", memberId, roleId);
    }

    await beat("BARREL");

    await beat("REDISTRIBUTION");
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

    // Narrated after verification, so the Pakled never remarks on a result that
    // did not actually happen.
    if (args.onBeat !== undefined) await args.onBeat("AFTERMATH").catch(() => undefined);

    onState("COMPLETE");
    return { status: "COMPLETE", mutations: applied.length };
  } catch (cause) {
    return await fail((cause as Error).message);
  }
};
