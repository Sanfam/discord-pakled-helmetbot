import { join } from "node:path";
import { ConfigError, loadConfig, loadEnvironment } from "./config.ts";
import { connect, DisallowedIntentsError, listRoles, openGuild, rolePort, snapshotGuild } from "./discord.ts";
import { applyReconciliation, describeOp, reconcile } from "./helmets.ts";
import { createLogger } from "./logger.ts";
import { checkReadiness, type ReadinessReport } from "./readiness.ts";
import { openStore } from "./store.ts";

const render = (heading: string, report: ReadinessReport, extra: string[] = []): void => {
  console.error(`\n${heading}`);
  for (const line of [...report.notes, ...extra]) console.error(`  · ${line}`);
  for (const problem of report.problems) console.error(`  ✗ ${problem}`);
};

const main = async (): Promise<number> => {
  const env = loadEnvironment();
  const config = loadConfig(env.dataDir);
  const log = createLogger(config.logging.level);
  const { dryRun } = config.development;

  log.info("starting", { dataDir: env.dataDir, guildId: env.discordGuildId, dryRun });

  const client = await connect(env.discordToken);
  log.info("connected", { user: client.user.tag });

  try {
    const guild = await openGuild(client, env.discordGuildId);
    const roles = await listRoles(guild);
    const before = checkReadiness(await snapshotGuild(guild, roles, config), config.helmets);

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
    store.close();

    // Re-verify against the guild as it now stands: provisioning shifts role
    // positions, so the pre-flight check is not evidence about the end state.
    const after = checkReadiness(await snapshotGuild(guild, await listRoles(guild), config), config.helmets);
    for (const problem of after.problems) log.error(problem);
    log.info(after.ok ? "readiness: OK" : "readiness: NOT READY", { ok: after.ok });

    const summary =
      ops.length === 0
        ? "Helmet Set: already in sync, nothing to do"
        : `Helmet Set: ${ops.length} ${dryRun ? "change(s) pending (dry run — nothing applied)" : "change(s) applied"}`;
    render(after.ok ? "READY" : "NOT READY", after, [summary, ...ops.map((op) => `  ${dryRun ? "would " : ""}${describeOp(op)}`)]);

    return after.ok ? 0 : 1;
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
