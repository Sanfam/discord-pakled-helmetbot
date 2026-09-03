import { join } from "node:path";
import {
  cryptoRandom,
  eligibleMembers,
  planCeremony,
  PLANNING_STATES,
  summariseEligibility,
  type Member,
} from "./ceremony.ts";
import { ConfigError, loadConfig, loadEnvironment, type Config } from "./config.ts";
import {
  connect,
  DisallowedIntentsError,
  listMembers,
  listRoles,
  openGuild,
  rolePort,
  snapshotGuild,
} from "./discord.ts";
import { applyReconciliation, describeOp, reconcile } from "./helmets.ts";
import type { Logger } from "./logger.ts";
import { createLogger } from "./logger.ts";
import { checkReadiness, type ReadinessReport } from "./readiness.ts";
import { openStore, type Store } from "./store.ts";

const render = (heading: string, report: ReadinessReport, extra: string[] = []): void => {
  console.error(`\n${heading}`);
  for (const line of [...report.notes, ...extra]) console.error(`  · ${line}`);
  for (const problem of report.problems) console.error(`  ✗ ${problem}`);
};

/**
 * Plan a Ceremony and report it. Nothing is assigned: applying a plan, and rolling
 * it back when Discord fails partway, belongs to the next ticket. Every Ceremony
 * recorded here is therefore marked as a dry run.
 */
const planOnlyCeremony = (
  config: Config,
  guildId: string,
  pakledId: string,
  members: Member[],
  botHighestRolePosition: number,
  store: Store,
  log: Logger,
): string[] => {
  const rules = {
    pakledId,
    botHighestRolePosition,
    excludedUserIds: config.participants.excludedUserIds,
    excludedRoleIds: config.participants.excludedRoleIds,
  };
  const eligible = eligibleMembers(members, rules);
  const summary = summariseEligibility(members, rules);

  const ceremonyId = store.beginCeremony(guildId, true);
  const plan = (() => {
    try {
      for (const state of PLANNING_STATES.slice(0, -1)) store.recordTransition(ceremonyId, state);
      const planned = planCeremony(config.helmets, eligible, pakledId, cryptoRandom);
      store.recordAssignments(ceremonyId, planned.assignments);
      store.recordTransition(ceremonyId, "COMPLETE");
      store.completeCeremony(ceremonyId, "COMPLETE");
      return planned;
    } catch (cause) {
      // A Ceremony that dies mid-flight is FAILED, not left lingering at whatever
      // state it reached with completed_at still null.
      store.recordTransition(ceremonyId, "FAILED");
      store.completeCeremony(ceremonyId, "FAILED");
      log.error("ceremony failed", { ceremonyId, reason: (cause as Error).message });
      throw cause;
    }
  })();

  const helmetName = new Map(config.helmets.map((h) => [h.id, h.name]));
  const memberName = new Map(members.map((m) => [m.id, m.displayName]));
  const rank = new Map(config.helmets.map((h) => [h.id, h.rank]));

  log.info("ceremony planned", {
    ceremonyId,
    dryRun: true,
    eligible: eligible.length,
    excluded: { otherBots: summary.otherBots, byConfig: summary.excludedByConfig, aboveTheBot: summary.aboveTheBot },
    assigned: plan.assignments.length,
    leftover: plan.leftoverHelmetIds.length,
  });

  const lines = [
    `Ceremony ${ceremonyId} (dry run — nothing was assigned)`,
    `  ${summary.eligible} Eligible Member(s) of ${members.length} in the guild` +
      ` — excluded: ${summary.otherBots} other bot(s), ${summary.excludedByConfig} by config,` +
      ` ${summary.aboveTheBot} whose own role outranks the bot's`,
    ...[...plan.assignments]
      .sort((a, b) => (rank.get(b.helmetId) ?? 0) - (rank.get(a.helmetId) ?? 0))
      .map((a) => {
        const who = memberName.get(a.memberId) ?? a.memberId;
        return `  ${helmetName.get(a.helmetId) ?? a.helmetId} → ${who}${a.memberId === pakledId ? "  (The Pakled)" : ""}`;
      }),
  ];
  if (plan.leftoverHelmetIds.length > 0) {
    lines.push(
      `  Left in the Great Helmet Barrel: ${plan.leftoverHelmetIds.map((id) => helmetName.get(id) ?? id).join(", ")}`,
    );
  }
  return lines;
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
        extra.push(
          ...planOnlyCeremony(
            config,
            env.discordGuildId,
            client.user.id,
            members,
            afterSnapshot.botHighestRolePosition,
            store,
            log,
          ),
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
