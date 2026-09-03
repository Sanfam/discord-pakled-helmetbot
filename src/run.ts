import {
  applyCeremony,
  cryptoRandom,
  eligibleMembers,
  holdersOf,
  memberLabels,
  planCeremony,
  PLANNING_STATES,
  summariseEligibility,
  type CeremonyEffects,
  type Member,
} from "./ceremony.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import { CeremonyInFlightError, type Store } from "./store.ts";

/**
 * The outcome, stated rather than inferred. The scheduler needs to know whether a
 * Ceremony failed; sniffing that out of human-readable lines would break the moment
 * someone reworded one.
 */
export type CeremonyRun = {
  status: "COMPLETE" | "FAILED" | "REFUSED";
  lines: string[];
};

export /**
 * Run a Ceremony: plan it, and unless this is a dry run, apply it and verify the
 * result against the guild. A failure restores the previous Helmet Holders and
 * the Ceremony is marked FAILED.
 */
const runCeremony = async (args: {
  config: Config;
  guildId: string;
  pakledId: string;
  members: Member[];
  botHighestRolePosition: number;
  roleByHelmet: Map<string, string>;
  store: Store;
  log: Logger;
  effects: CeremonyEffects;
  readHolders: (memberIds: string[]) => Promise<Map<string, string[]>>;
  report: (text: string) => Promise<boolean>;
  /** Selection weight per member. Omitted, everyone is equally likely. */
  weightOf?: ((member: Member) => number) | undefined;
}): Promise<CeremonyRun> => {
  const { config, guildId, pakledId, members, store, log } = args;
  const dryRun = config.development.dryRun;

  // Two Ceremonies must never run at once. The database enforces this with a unique
  // index over unfinished ceremonies, so two processes racing cannot both pass.
  //
  // ponytail: a hard kill, or a storage failure in the error path below, strands a
  // row in flight and blocks future Ceremonies until an operator clears it. Add a
  // lease with an expiry if that ever happens in practice.
  const inFlight = store.inFlightCeremony(guildId);
  if (inFlight !== undefined) {
    log.error("refusing to start: a ceremony is already in flight", { ceremonyId: inFlight.id, status: inFlight.status });
    return { status: "REFUSED", lines: [`Ceremony refused: ${inFlight.id} is still in flight (${inFlight.status}).`] };
  }

  const rules = {
    pakledId,
    botHighestRolePosition: args.botHighestRolePosition,
    excludedUserIds: config.participants.excludedUserIds,
    excludedRoleIds: config.participants.excludedRoleIds,
  };
  const eligible = eligibleMembers(members, rules);
  const summary = summariseEligibility(members, rules);

  const helmetName = new Map(config.helmets.map((h) => [h.id, h.name]));
  const memberName = memberLabels(members);
  const rank = new Map(config.helmets.map((h) => [h.id, h.rank]));
  const biggestHelmetId = config.helmets.reduce((a, b) => (b.rank > a.rank ? b : a)).id;

  let ceremonyId: string;
  try {
    ceremonyId = store.beginCeremony(guildId, dryRun);
  } catch (cause) {
    if (cause instanceof CeremonyInFlightError) {
      log.error("refusing to start: a ceremony is already in flight");
      return { status: "REFUSED", lines: ["Ceremony refused: another ceremony is already in flight."] };
    }
    throw cause;
  }
  let mutationsBegan = false;
  const header = [
    `Ceremony ${ceremonyId}${dryRun ? " (dry run — nothing was assigned)" : ""}`,
    `  ${summary.eligible} Eligible Member(s) of ${members.length} in the guild` +
      ` — excluded: ${summary.otherBots} other bot(s), ${summary.excludedByConfig} by config,` +
      ` ${summary.aboveTheBot} whose own role outranks the bot's`,
  ];

  const describe = (plan: { assignments: { helmetId: string; memberId: string }[]; leftoverHelmetIds: string[] }) => [
    ...[...plan.assignments]
      .sort((a, b) => (rank.get(b.helmetId) ?? 0) - (rank.get(a.helmetId) ?? 0))
      .map((a) => {
        const who = memberName.get(a.memberId) ?? a.memberId;
        return `  ${helmetName.get(a.helmetId) ?? a.helmetId} → ${who}${a.memberId === pakledId ? "  (The Pakled)" : ""}`;
      }),
    ...(plan.leftoverHelmetIds.length > 0
      ? [`  Left in the Great Helmet Barrel: ${plan.leftoverHelmetIds.map((id) => helmetName.get(id) ?? id).join(", ")}`]
      : []),
  ];

  try {
    const plan = planCeremony(config.helmets, eligible, pakledId, cryptoRandom, args.weightOf);
    store.recordAssignments(ceremonyId, plan.assignments);

    if (dryRun) {
      for (const state of PLANNING_STATES.slice(0, -1)) store.recordTransition(ceremonyId, state);
      store.recordTransition(ceremonyId, "COMPLETE");
      store.completeCeremony(ceremonyId, "COMPLETE");
      log.info("ceremony planned", { ceremonyId, dryRun: true, assigned: plan.assignments.length });
      return { status: "COMPLETE", lines: [...header, ...describe(plan)] };
    }

    // Recorded before a single role is mutated: this is what rollback restores.
    const previousHolders = holdersOf(members, args.roleByHelmet);
    store.recordPreviousHolders(ceremonyId, previousHolders);
    mutationsBegan = true;

    const outcome = await applyCeremony({
      plan,
      roleByHelmet: args.roleByHelmet,
      biggestHelmetId,
      previousHolders,
      effects: args.effects,
      readHolders: args.readHolders,
      onState: (state) => store.recordTransition(ceremonyId, state),
    });

    if (outcome.status === "COMPLETE") {
      store.completeCeremony(ceremonyId, "COMPLETE");
      log.info("ceremony complete", { ceremonyId, mutations: outcome.mutations });
      return { status: "COMPLETE", lines: [...header, ...describe(plan)] };
    }

    store.completeCeremony(ceremonyId, "FAILED");
    log.error("ceremony failed", { ceremonyId, reason: outcome.reason, rolledBack: outcome.rolledBack });

    const lines = [
      `Ceremony ${ceremonyId} FAILED: ${outcome.reason}`,
      outcome.rolledBack
        ? "  Previous Helmet Holders were restored."
        : `  ROLLBACK INCOMPLETE: ${outcome.rollbackError}. The Helmet Set needs manual attention.`,
    ];
    await args.report(lines.join("\n"));
    return { status: "FAILED", lines: [...header, ...lines] };
  } catch (cause) {
    const reason = (cause as Error).message;
    // Best effort: if storage is what broke, this will fail too, and the row is left
    // in flight rather than silently marked finished.
    try {
      store.recordTransition(ceremonyId, "FAILED");
      store.completeCeremony(ceremonyId, "FAILED");
    } catch (storeError) {
      log.error("could not record ceremony failure", { ceremonyId, reason: (storeError as Error).message });
    }
    // Only claim nothing changed when nothing had started changing. A failure after
    // redistribution has left real role changes behind.
    const scope = mutationsBegan
      ? "AFTER role changes began — the Helmet Set may need manual attention"
      : "before any role was changed";
    log.error("ceremony failed", { ceremonyId, reason, mutationsBegan });
    await args.report(`Ceremony ${ceremonyId} FAILED ${scope}: ${reason}`);
    return { status: "FAILED", lines: [...header, `Ceremony ${ceremonyId} FAILED ${scope}: ${reason}`] };
  }
};
