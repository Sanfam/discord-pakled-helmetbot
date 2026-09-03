import { join } from "node:path";
import {
  applyCeremony,
  cryptoRandom,
  eligibleMembers,
  helmetRoleMap,
  holdersOf,
  memberLabels,
  planCeremony,
  PLANNING_STATES,
  summariseEligibility,
  type Member,
} from "./ceremony.ts";
import { ConfigError, loadConfig, loadEnvironment, type Config } from "./config.ts";
import {
  announce,
  connect,
  DisallowedIntentsError,
  listMembers,
  listRoles,
  holdersAmong,
  memberRolePort,
  openGuild,
  rolePort,
  snapshotGuild,
} from "./discord.ts";
import { applyReconciliation, describeOp, reconcile } from "./helmets.ts";
import type { Logger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import type { CeremonyEffects } from "./ceremony.ts";
import { checkReadiness, type ReadinessReport } from "./readiness.ts";
import { CeremonyInFlightError, openStore, type Store } from "./store.ts";

const render = (heading: string, report: ReadinessReport, extra: string[] = []): void => {
  console.error(`\n${heading}`);
  for (const line of [...report.notes, ...extra]) console.error(`  · ${line}`);
  for (const problem of report.problems) console.error(`  ✗ ${problem}`);
};

/**
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
}): Promise<string[]> => {
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
    return [`Ceremony refused: ${inFlight.id} is still in flight (${inFlight.status}).`];
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
      return ["Ceremony refused: another ceremony is already in flight."];
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
    const plan = planCeremony(config.helmets, eligible, pakledId, cryptoRandom);
    store.recordAssignments(ceremonyId, plan.assignments);

    if (dryRun) {
      for (const state of PLANNING_STATES.slice(0, -1)) store.recordTransition(ceremonyId, state);
      store.recordTransition(ceremonyId, "COMPLETE");
      store.completeCeremony(ceremonyId, "COMPLETE");
      log.info("ceremony planned", { ceremonyId, dryRun: true, assigned: plan.assignments.length });
      return [...header, ...describe(plan)];
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
      return [...header, ...describe(plan)];
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
    return [...header, ...lines];
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
    return [...header, `Ceremony ${ceremonyId} FAILED ${scope}: ${reason}`];
  }
};

const main = async (): Promise<number> => {
  const command = process.argv[2] ?? "start";
  if (!["start", "ceremony"].includes(command)) {
    console.error(`Unknown command "${command}". Expected: start | ceremony`);
    return 1;
  }

  const env = loadEnvironment();
  const config = loadConfig(env.dataDir);
  const log = createLogger(config.logging.level);
  const { dryRun } = config.development;

  log.info("starting", { command, dataDir: env.dataDir, guildId: env.discordGuildId, dryRun });

  const client = await connect(env.discordToken);
  log.info("connected", { user: client.user.tag });

  try {
    const guild = await openGuild(client, env.discordGuildId);
    const roles = await listRoles(guild);
    const snapshot = await snapshotGuild(guild, roles, config);
    const before = checkReadiness(snapshot, config.helmets);

    // Role management stays disabled when the guild is not ready. The process
    // reports and exits rather than crashing, and changes nothing.
    if (!before.ok) {
      for (const problem of before.problems) log.error(problem);
      log.error("role management disabled: guild is not ready");
      render("NOT READY — role management disabled, nothing was changed", before);
      return 1;
    }

    if (!config.enabled) {
      log.warn("disabled by configuration: no roles will be created, renamed or deleted");
      render("DISABLED — nothing was changed", before);
      return 0;
    }

    const store = openStore(join(env.dataDir, "bot.sqlite"));
    try {
      const ops = reconcile(config.helmets, store.helmetRoles(env.discordGuildId), roles);

      if (ops.length === 0) {
        log.info("Helmet Set is already in sync");
      } else if (dryRun) {
        for (const op of ops) log.info(`would ${describeOp(op)}`, { dryRun: true });
      } else {
        for (const op of ops) log.info(describeOp(op));
        await applyReconciliation(ops, rolePort(guild), {
          record: (helmetId, roleId) => store.recordHelmetRole(env.discordGuildId, helmetId, roleId),
          forget: (helmetId) => store.forgetHelmetRole(env.discordGuildId, helmetId),
        });
        log.info("Helmet Set reconciled", { operations: ops.length });
      }

      const extra: string[] = [
        ops.length === 0
          ? "Helmet Set: already in sync, nothing to do"
          : `Helmet Set: ${ops.length} ${dryRun ? "change(s) pending (dry run — nothing applied)" : "change(s) applied"}`,
        ...ops.map((op) => `  ${dryRun ? "would " : ""}${describeOp(op)}`),
      ];

      // Re-snapshot before doing anything else: provisioning shifts every role up
      // by one per role created, the bot's own included. The pre-flight snapshot is
      // stale from here on, and comparing fresh member positions against a stale bot
      // position would wrongly exclude Eligible Members on a first provisioning run.
      const afterSnapshot = await snapshotGuild(guild, await listRoles(guild), config);
      const after = checkReadiness(afterSnapshot, config.helmets);

      if (command === "ceremony") {
        const members = await listMembers(guild);
        const roleByHelmet = helmetRoleMap(config.helmets, store.helmetRoles(env.discordGuildId));
        extra.push(
          ...(await runCeremony({
            config,
            guildId: env.discordGuildId,
            pakledId: client.user.id,
            members,
            botHighestRolePosition: afterSnapshot.botHighestRolePosition,
            roleByHelmet,
            store,
            log,
            effects: memberRolePort(guild),
            readHolders: (memberIds) => holdersAmong(guild, memberIds, roleByHelmet),
            report: (text) => announce(client, config.channels.adminChannelId, text),
          })),
        );
      }

      for (const problem of after.problems) log.error(problem);
      log.info(after.ok ? "readiness: OK" : "readiness: NOT READY", { ok: after.ok });
      render(after.ok ? "READY" : "NOT READY", after, extra);

      return after.ok ? 0 : 1;
    } finally {
      store.close();
    }
  } finally {
    await client.destroy();
  }
};

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof ConfigError || error instanceof DisallowedIntentsError) {
    console.error(`\n${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}
