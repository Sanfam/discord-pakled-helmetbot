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
import type { Client } from "discord.js";
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
import { generateAndWrite } from "./golden.ts";
import { loadPrompt } from "./llm.ts";
import { createLogger } from "./logger.ts";
import type { CeremonyEffects } from "./ceremony.ts";
import { checkReadiness, type ReadinessReport } from "./readiness.ts";
import { handleCommands, registerCommands } from "./commands.ts";
import { afterFailure, afterSuccess, circuitBroken, isDue, type Schedule } from "./schedule.ts";
import { runCeremony, type CeremonyRun } from "./run.ts";
import { openStore, type Store } from "./store.ts";

const render = (heading: string, report: ReadinessReport, extra: string[] = []): void => {
  console.error(`\n${heading}`);
  for (const line of [...report.notes, ...extra]) console.error(`  · ${line}`);
  for (const problem of report.problems) console.error(`  ✗ ${problem}`);
};

/**
 * Long-running mode: watch the clock, run a Ceremony when one is due, and answer
 * the administrative commands.
 *
 * The database is the single source of truth for the schedule, re-read on every
 * tick rather than cached. Two daemons overlapping during a deployment would
 * otherwise both hold the same due timestamp: one runs the Ceremony, the other is
 * refused, and then runs it again a minute later against its stale copy.
 */
const runDaemon = async (args: {
  client: Client<true>;
  guildId: string;
  config: Config;
  store: Store;
  log: Logger;
  ceremony: () => Promise<CeremonyRun>;
}): Promise<void> => {
  const { client, guildId, config, store, log, ceremony } = args;
  const timing = config.ceremony;

  const describe = (schedule: Schedule) => ({
    nextCeremonyAt: schedule.nextCeremonyAt === null ? null : new Date(schedule.nextCeremonyAt).toISOString(),
    paused: schedule.paused,
    consecutiveFailures: schedule.consecutiveFailures,
  });

  /** Saves, then reports a tripped breaker. Never throws: storage trouble must not
   *  kill a process meant to run for weeks. */
  const persist = async (next: Schedule): Promise<void> => {
    try {
      store.saveSchedule(guildId, next);
    } catch (cause) {
      log.error("could not persist the schedule", { reason: (cause as Error).message });
      return;
    }
    log.info("ceremony scheduled", describe(next));
    if (circuitBroken(next, timing.maxConsecutiveFailures)) {
      log.error("circuit breaker tripped: ceremonies are disabled until an operator resumes them", {
        consecutiveFailures: next.consecutiveFailures,
      });
      await announce(
        client,
        config.channels.adminChannelId,
        `Ceremonies are disabled after ${next.consecutiveFailures} consecutive failures. Use /helmet resume.`,
      );
    }
  };

  const existing = store.schedule(guildId);

  // Only ever seed a schedule that does not exist. Rescheduling on start would fire
  // a Ceremony on every redeploy, which is what persistence exists to prevent.
  if (existing.nextCeremonyAt === null && !existing.paused && !circuitBroken(existing, timing.maxConsecutiveFailures)) {
    if (timing.enabled) await persist(afterSuccess(Date.now(), timing, cryptoRandom, existing));
    else log.warn("ceremonies are disabled by configuration; none will be scheduled");
  } else {
    log.info("resuming existing schedule", {
      ...describe(existing),
      circuitBroken: circuitBroken(existing, timing.maxConsecutiveFailures),
    });
  }

  await registerCommands(client, guildId);
  handleCommands(client, guildId, {
    pause: async () => {
      // Read-modify-write against the store, never against a cached copy.
      await persist({ ...store.schedule(guildId), paused: true });
      return "The helmets stay where they are. For now.";
    },
    resume: async () => {
      const cleared = { ...store.schedule(guildId), paused: false, consecutiveFailures: 0 };
      await persist(
        cleared.nextCeremonyAt === null ? afterSuccess(Date.now(), timing, cryptoRandom, cleared) : cleared,
      );
      return "The plan continues.";
    },
  });

  let inFlight: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    const current = store.schedule(guildId);
    if (!timing.enabled || !isDue(current, Date.now(), timing)) return;

    try {
      const { status } = await ceremony();
      // A refusal means another process holds the in-flight lock. It is not a
      // failure, and the schedule it is about to write is the one that counts —
      // so leave it alone and re-read next tick.
      if (status === "REFUSED") {
        log.info("ceremony refused: another run holds the lock");
        return;
      }
      await persist((status === "FAILED" ? afterFailure : afterSuccess)(Date.now(), timing, cryptoRandom, current));
    } catch (cause) {
      // Computed from `current`, not from a value already advanced above, so one
      // Ceremony cannot count as two failures.
      log.error("ceremony threw", { reason: (cause as Error).message });
      await persist(afterFailure(Date.now(), timing, cryptoRandom, current));
    }
  };

  const timer = setInterval(() => {
    if (inFlight !== null) return;
    // Nothing may escape as an unhandled rejection: the interval callback cannot
    // observe one, and it would take the process down.
    inFlight = tick()
      .catch((cause: unknown) => log.error("tick failed", { reason: (cause as Error).message }))
      .finally(() => void (inFlight = null));
  }, timing.checkIntervalSeconds * 1000);

  log.info("running", { checkIntervalSeconds: timing.checkIntervalSeconds });
  console.error("\nRunning. The Pakled is waiting. Ctrl-C to stop.");

  await new Promise<void>((resolve) => {
    const stop = async (signal: string) => {
      clearInterval(timer);
      if (inFlight !== null) {
        // Tearing down mid-Ceremony strands its in-flight database row, and every
        // later Ceremony is then refused until an operator clears it by hand.
        log.info("waiting for the ceremony in progress before shutting down", { signal });
        console.error("\nFinishing the ceremony in progress before stopping…");
        await inFlight;
      }
      log.info("shutting down", { signal });
      resolve();
    };
    process.once("SIGINT", () => void stop("SIGINT"));
    process.once("SIGTERM", () => void stop("SIGTERM"));
  });
};

const main = async (): Promise<number> => {
  const command = process.argv[2] ?? "start";
  if (!["start", "ceremony", "golden"].includes(command)) {
    console.error(`Unknown command "${command}". Expected: start | ceremony | golden`);
    return 1;
  }

  const env = loadEnvironment();
  const config = loadConfig(env.dataDir);
  const log = createLogger(config.logging.level);

  // Generating golden samples needs no Discord connection at all.
  if (command === "golden") {
    if (env.openrouterApiKey === null) {
      console.error("Generating samples needs OPENROUTER_API_KEY. Set it in .env.");
      return 1;
    }
    const models = process.argv.slice(3);
    await generateAndWrite(
      env.openrouterApiKey,
      models.length > 0 ? models : [config.llm.model],
      loadPrompt(config.llm.promptPath),
      "prompts/golden.md",
      config.llm.minRequestIntervalMs,
      (msg) => log.info(msg),
    );
    return 0;
  }
  const { dryRun } = config.development;

  if (env.openrouterApiKey === null) {
    log.warn("OPENROUTER_API_KEY is not set: the Pakled will speak in fallback lines only");
  }

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

      const ceremony = async (): Promise<CeremonyRun> => {
        const members = await listMembers(guild);
        const roleByHelmet = helmetRoleMap(config.helmets, store.helmetRoles(env.discordGuildId));
        const fresh = await snapshotGuild(guild, await listRoles(guild), config);
        return runCeremony({
          config,
          guildId: env.discordGuildId,
          pakledId: client.user.id,
          members,
          botHighestRolePosition: fresh.botHighestRolePosition,
          roleByHelmet,
          store,
          log,
          effects: memberRolePort(guild),
          readHolders: (memberIds) => holdersAmong(guild, memberIds, roleByHelmet),
          report: (text) => announce(client, config.channels.adminChannelId, text),
        });
      };

      if (command === "ceremony") extra.push(...(await ceremony()).lines);

      for (const problem of after.problems) log.error(problem);
      log.info(after.ok ? "readiness: OK" : "readiness: NOT READY", { ok: after.ok });
      render(after.ok ? "READY" : "NOT READY", after, extra);

      if (command !== "start" || !after.ok) return after.ok ? 0 : 1;

      await runDaemon({ client, guildId: env.discordGuildId, config, store, log, ceremony });
      return 0;
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
