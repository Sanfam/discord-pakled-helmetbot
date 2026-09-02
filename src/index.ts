import { ConfigError, loadConfig, loadEnvironment } from "./config.ts";
import { connect, DisallowedIntentsError, snapshotGuild } from "./discord.ts";
import { createLogger } from "./logger.ts";
import { checkReadiness } from "./readiness.ts";

/**
 * Ticket #2: connect, resolve the configured guild, and report whether this
 * server is set up correctly. Nothing in the guild is created or changed.
 */
const main = async (): Promise<number> => {
  const env = loadEnvironment();
  const config = loadConfig(env.dataDir);
  const log = createLogger(config.logging.level);

  log.info("starting", { dataDir: env.dataDir, guildId: env.discordGuildId, dryRun: config.development.dryRun });

  const client = await connect(env.discordToken);
  log.info("connected", { user: client.user.tag });

  try {
    const snapshot = await snapshotGuild(client, env.discordGuildId, config);
    const report = checkReadiness(snapshot, config.helmets);

    for (const note of report.notes) log.info(note);
    for (const problem of report.problems) log.error(problem);
    log.info(report.ok ? "readiness: OK" : "readiness: NOT READY", { ok: report.ok });

    console.error(`\n${report.ok ? "READY" : "NOT READY"}`);
    for (const note of report.notes) console.error(`  · ${note}`);
    for (const problem of report.problems) console.error(`  ✗ ${problem}`);

    return report.ok ? 0 : 1;
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
