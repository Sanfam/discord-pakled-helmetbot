import { join } from "node:path";
import {
  activityWeight,
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
import { Events, type Guild, type Message } from "discord.js";
import {
  announce,
  connect,
  DisallowedIntentsError,
  listMembers,
  listRoles,
  holdersAmong,
  memberRolePort,
  openGuild,
  pakledSituation,
  recentMessages,
  withTimeout,
  sendTo,
  speakableChannels,
  rolePort,
  snapshotGuild,
} from "./discord.ts";
import { applyReconciliation, describeOp, reconcile } from "./helmets.ts";
import type { Logger } from "./logger.ts";
import { generateAndWrite } from "./golden.ts";
import {
  fallbackLine,
  loadPrompt,
  openRouterProvider,
  parseInterjection,
  parseSpoken,
  rateLimited,
  type LLMProvider,
} from "./llm.ts";
import { BEATS, beatDelays, FALLBACK_BEATS, type Beat } from "./narration.ts";
import { createLogger } from "./logger.ts";
import type { CeremonyEffects } from "./ceremony.ts";
import { checkReadiness, type ReadinessReport } from "./readiness.ts";
import { handleCommands, registerCommands } from "./commands.ts";
import { answerMention, channelAllowed, createCooldown, reduceHistory } from "./mentions.ts";
import {
  nextPassiveDelay,
  selectActiveChannel,
  shouldConsiderSpeaking,
  type ActivityEvent,
} from "./passive.ts";
import { ceremonyRequest, interjectionRequest } from "./voice.ts";
import { afterFailure, afterSuccess, circuitBroken, isDue, type Schedule } from "./schedule.ts";
import { runCeremony, type CeremonyRun } from "./run.ts";
import { holdersLines, nextCeremonyLine, statusReport, type StatusView } from "./status.ts";
import { openStore, type Store } from "./store.ts";

const render = (heading: string, report: ReadinessReport, extra: string[] = []): void => {
  console.error(`\n${heading}`);
  for (const line of [...report.notes, ...extra]) console.error(`  · ${line}`);
  for (const problem of report.problems) console.error(`  ✗ ${problem}`);
};

/** No single narration step may hold a half-applied Ceremony open longer than this. */
const BEAT_TIMEOUT_MS = 30_000;
/** Longer than a beat, shorter than a container's patience. */
const SHUTDOWN_WAIT_MS = 45_000;

/**
 * Remove the bot's own mention from the text, leaving the question.
 *
 * Deliberately not a regex built from the display name: a name containing regex
 * metacharacters would throw at construction and silently swallow the mention, and
 * a guild nickname differing from the account name would leave it in the question.
 */
const withoutOwnMention = (message: Message, botId: string): string => {
  const raw = message.content.replaceAll(`<@${botId}>`, " ").replaceAll(`<@!${botId}>`, " ");
  return raw.replace(/<[@#][!&]?\d+>/g, " ").replace(/\s+/g, " ").trim();
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
  prompt: string;
  guild: Guild;
  provider: LLMProvider | null;
  biggestHelmetId: string;
}): Promise<void> => {
  const { client, guildId, config, store, log, ceremony, guild } = args;
  const timing = config.ceremony;
  let passiveTimer: NodeJS.Timeout | null = null;
  let passiveInFlight: Promise<void> | null = null;
  let stopping = false;

  // A gateway gap is invisible from inside the handlers: messages sent during one
  // are never delivered and never replayed beyond what a resume carries. Without
  // these, "the bot ignored me" and "the bot never saw it" look identical.
  client.on(Events.ShardDisconnect, (event, shardId) =>
    log.warn("gateway disconnected", { shardId, code: event.code, reason: event.reason || null }),
  );
  client.on(Events.ShardReconnecting, (shardId) => log.debug("gateway reconnecting", { shardId }));
  // replayedEvents is the number that matters: zero after a long gap means messages
  // were dropped, not merely delayed.
  client.on(Events.ShardResume, (shardId, replayedEvents) => log.info("gateway resumed", { shardId, replayedEvents }));
  client.on(Events.ShardError, (error, shardId) => log.error("gateway error", { shardId, reason: error.message }));
  client.on(Events.GuildUnavailable, (unavailable) => {
    if (unavailable.id === guildId) log.warn("the guild went unavailable; Discord is having trouble");
  });

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

  // A process killed mid-Ceremony leaves a row that has begun and never finished,
  // and every later Ceremony is refused against it. Nothing else clears it, so
  // startup does.
  const stranded = store.inFlightCeremony(guildId);
  if (stranded !== undefined) {
    store.abandonCeremony(stranded.id, "abandoned: the bot stopped while it was running");
    log.warn("recovered a ceremony stranded by a previous shutdown", { ceremonyId: stranded.id, status: stranded.status });
  }

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

  const { provider, biggestHelmetId } = args;
  const activity = new Map<string, ActivityEvent[]>();
  const floorWindowMs = config.conversation.passive.activityFloor.windowMinutes * 60_000;

  // Every human message counts toward the activity floor and channel scoring,
  // whether or not mentions are answered: passive conversation is configured
  // independently and must not be disabled by proxy.
  client.on(Events.MessageCreate, (message) => {
    if (message.guildId !== guildId || message.author.bot) return;
    try {
      // Timestamps only — who was around and when. No content.
      store.recordMemberActivity(guildId, message.author.id, message.createdTimestamp);
      store.recordChannelMessage(guildId, message.channelId, message.createdTimestamp);
      const events = activity.get(message.channelId) ?? [];
      events.push({ at: message.createdTimestamp, authorId: message.author.id });
      activity.set(
        message.channelId,
        events.filter((e) => Date.now() - e.at <= floorWindowMs),
      );
    } catch (cause) {
      log.error("could not record channel activity", { reason: (cause as Error).message });
    }
  });

  // Answering when spoken to.
  if (config.conversation.mentionEnabled) {
    const cooldown = createCooldown(config.conversation.mentionCooldownSeconds * 1000);
    const channelCooldown = createCooldown(config.conversation.channelCooldownSeconds * 1000);
    // A hard ceiling on work in flight. The cooldowns shape who is answered; this
    // stops a crowd turning into an unbounded queue of paid requests and REST calls.
    let answering = 0;
    client.on(Events.MessageCreate, (message) => {
      // Nothing may escape: the emitter cannot observe this promise.
      void (async () => {
        if (message.author.bot || message.guildId !== guildId) return;
        // The first question of any silence is whether the mention arrived at all: a
        // reply with its ping switched off, or a role mention, reads as a mention to a
        // human but never reaches mentions.users.
        if (!message.mentions.users.has(client.user.id)) return;
        log.debug("mentioned", { userId: message.author.id, channelId: message.channelId });
        if (answering >= config.conversation.maxConcurrentMentions) {
          log.warn("ignoring a mention: already answering as many as allowed at once");
          return;
        }

        answering++;
        try {
          await respondToMention(message);
        } finally {
          answering--;
        }
      })().catch((cause: unknown) =>
        log.error("mention failed", {
          reason: (cause as Error).message,
          userId: message.author.id,
          channelId: message.channelId,
        }),
      );
    });

    const respondToMention = async (message: Message): Promise<void> => {
      // Discord's indicator lasts ten seconds and cannot be cancelled, only
      // outlived: it is refreshed under that while the model is slow, and simply
      // expires once the reply lands.
      let typing: NodeJS.Timeout | null = null;
      const showTyping = (): void => {
        const channel = message.channel;
        if (!("sendTyping" in channel)) return;
        const send = () => void channel.sendTyping().catch(() => undefined);
        send();
        typing = setInterval(send, 8_000);
      };

      try {
        const parent = "parentId" in message.channel ? message.channel.parentId : null;
        const reply = await answerMention({
          channelId: message.channelId,
          parentId: parent,
          userId: message.author.id,
          question: withoutOwnMention(message, client.user.id),
          now: Date.now(),
          channels: { deny: config.channels.deny, adminChannelId: config.channels.adminChannelId },
          userCooldown: cooldown,
          channelCooldown,
          history: async () =>
            reduceHistory(
              await recentMessages(message.channel, config.conversation.mentionContextMessages, message.id),
              config.conversation.mentionContextMessages,
            ),
          context: () =>
            pakledSituation(
              message.guild!,
              client.user.id,
              config.helmets,
              helmetRoleMap(config.helmets, store.helmetRoles(guildId)),
              "name" in message.channel ? (message.channel.name ?? "here") : "here",
              store.currentHolderOf(guildId, biggestHelmetId) ?? null,
              store.currentMultihat(guildId) ?? null,
            ),
          provider,
          prompt: args.prompt,
          fallback: () => fallbackLine((max) => cryptoRandom.int(max)),
          onFallback: (reason) => log.warn("answered with a fallback line", { reason }),
          onDecline: (reason) =>
            log.debug("stayed quiet", { reason, userId: message.author.id, channelId: message.channelId }),
          onThinking: showTyping,
        });

        if (reply === null) return;
        await message.reply({ content: reply, allowedMentions: { repliedUser: true, parse: [] } });
        // Speaking is speaking: a passive cycle must not follow straight after a reply.
        store.recordBotMessage(guildId, message.channelId, Date.now());
      } finally {
        if (typing !== null) clearInterval(typing);
      }
    };
  }

  // Speaking unprompted.
  if (config.conversation.passive.enabled) {
    const passive = config.conversation.passive;

    const cycle = async (): Promise<void> => {
      const now = Date.now();
      // Prune every channel, not only the one that last spoke: a dormant or deleted
      // channel would otherwise keep its window forever.
      for (const [id, events] of activity) {
        const live = events.filter((e) => now - e.at <= floorWindowMs);
        if (live.length === 0) activity.delete(id);
        else activity.set(id, live);
      }

      const speakable = speakableChannels(guild, client.user.id).filter((c) =>
        channelAllowed(c.id, { deny: config.channels.deny, adminChannelId: config.channels.adminChannelId }, c.parentId),
      );
      if (speakable.length === 0) {
        log.debug("passive cycle: no channel is both speakable and allowed");
        return;
      }

      const known = new Map(store.channelActivity(guildId).map((a) => [a.channelId, a]));
      const candidates = speakable
        .map((c) => known.get(c.id))
        .filter((a): a is NonNullable<typeof a> => a !== undefined);
      const channelId = selectActiveChannel(candidates, now, cryptoRandom);
      if (channelId === null) {
        log.debug("passive cycle: no channel has any recorded activity yet");
        return;
      }

      const chosen = known.get(channelId)!;
      if (
        !shouldConsiderSpeaking(
          {
            events: activity.get(channelId) ?? [],
            now,
            floor: passive.activityFloor,
            lastBotMessageAt: chosen.lastBotMessageAt,
            channelCooldownMinutes: passive.channelCooldownMinutes,
            probability: passive.probability,
          },
          cryptoRandom,
        )
      ) {
        // Logged, because "why is it not talking?" is otherwise unanswerable.
        log.debug("passive cycle: gates declined", {
          channelId,
          recentEvents: (activity.get(channelId) ?? []).length,
          lastBotMessageAt: chosen.lastBotMessageAt,
        });
        return;
      }
      if (provider === null) {
        log.debug("passive cycle: gates passed but no LLM provider is configured", { channelId });
        return;
      }
      log.info("passive cycle: gates passed, asking", { channelId });

      const channel = await guild.channels.fetch(channelId);
      if (channel === null || !channel.isTextBased()) {
        log.debug("passive cycle: the chosen channel is gone or not text-based", { channelId });
        return;
      }

      const history = reduceHistory(await recentMessages(channel, config.conversation.mentionContextMessages));
      if (history.length === 0) {
        log.debug("passive cycle: nothing readable in the channel's recent history", { channelId });
        return;
      }

      const situation = await pakledSituation(
        guild,
        client.user.id,
        config.helmets,
        helmetRoleMap(config.helmets, store.helmetRoles(guildId)),
        "name" in channel ? (channel.name ?? "here") : "here",
        store.currentHolderOf(guildId, biggestHelmetId) ?? null,
        store.currentMultihat(guildId) ?? null,
      );

      // The model may still decline, and usually should.
      const decision = parseInterjection(await provider.complete(interjectionRequest(args.prompt, situation, history)));
      if (!decision.shouldRespond || decision.response === undefined) {
        log.info("passive cycle: stayed silent");
        return;
      }

      const spoken = await sendTo(guild, channelId, decision.response, (reason) =>
        log.warn("could not speak unprompted", { channelId, reason }),
      );
      if (spoken) {
        store.recordBotMessage(guildId, channelId, Date.now());
        log.info("spoke unprompted", { channelId });
      }
    };

    const schedulePassive = (): void => {
      // Never re-arm during shutdown: the store and the Discord client are about to
      // go away underneath it.
      if (stopping) return;
      const delay = nextPassiveDelay(passive.minIntervalMinutes, passive.maxIntervalMinutes, cryptoRandom);
      log.info("next passive cycle", { inMinutes: Math.round(delay / 60_000) });
      passiveTimer = setTimeout(() => {
        if (stopping) return;
        passiveInFlight = cycle()
          .catch((cause: unknown) => log.error("passive cycle failed", { reason: (cause as Error).message }))
          .finally(() => {
            passiveInFlight = null;
            schedulePassive();
          });
      }, delay);
    };
    schedulePassive();
  }

  /** Everything the read-only commands report, gathered fresh each time. */
  const currentView = async (): Promise<StatusView> => {
    const roleByHelmet = helmetRoleMap(config.helmets, store.helmetRoles(guildId));
    const holders = await Promise.all(
      config.helmets.map(async (helmet) => {
        const roleId = roleByHelmet.get(helmet.id);
        const memberId = roleId === undefined ? undefined : store.currentHolderOf(guildId, helmet.id);
        if (memberId === undefined || roleId === undefined) {
          return { helmetName: helmet.name, rank: helmet.rank, memberLabel: null };
        }
        try {
          const member = await guild.members.fetch({ user: memberId });
          // The database remembers who the last Ceremony chose; Discord knows who is
          // actually wearing it. An administrator moving a role by hand, or an
          // incomplete rollback, would otherwise be reported confidently and wrongly.
          if (!member.roles.cache.has(roleId)) return { helmetName: helmet.name, rank: helmet.rank, memberLabel: null };
          return { helmetName: helmet.name, rank: helmet.rank, memberLabel: member.displayName };
        } catch {
          // They may have left since the Ceremony that gave them the helmet.
          return { helmetName: helmet.name, rank: helmet.rank, memberLabel: null };
        }
      }),
    );
    return {
      schedule: store.schedule(guildId),
      maxConsecutiveFailures: timing.maxConsecutiveFailures,
      ceremoniesEnabled: timing.enabled,
      lastCeremony: store.ceremonies(guildId)[0],
      holders,
      llmModel: provider === null ? null : config.llm.model,
      now: Date.now(),
    };
  };

  await registerCommands(client, guildId);
  handleCommands(
    client,
    guildId,
    {
    status: async () => statusReport(await currentView()),
    next: async () => nextCeremonyLine(await currentView()),
    roles: async () => holdersLines(await currentView()).join("\n"),
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
    },
    (msg, cause) => log.error(msg, { reason: cause.message }),
  );

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
      // Re-read: a narrated Ceremony takes minutes, and a /helmet pause that arrived
      // during it would otherwise be undone by writing back the stale snapshot.
      const latest = { ...store.schedule(guildId), consecutiveFailures: current.consecutiveFailures };
      await persist((status === "FAILED" ? afterFailure : afterSuccess)(Date.now(), timing, cryptoRandom, latest));
    } catch (cause) {
      // Computed from `current`, not from a value already advanced above, so one
      // Ceremony cannot count as two failures.
      log.error("ceremony threw", { reason: (cause as Error).message });
      const latest = { ...store.schedule(guildId), consecutiveFailures: current.consecutiveFailures };
      await persist(afterFailure(Date.now(), timing, cryptoRandom, latest));
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
      stopping = true;
      clearInterval(timer);
      if (passiveTimer !== null) clearTimeout(passiveTimer);
      // Clearing the timer cannot stop a cycle that has already fired, and it would
      // otherwise keep running against a closed store and a destroyed client.
      if (passiveInFlight !== null) await passiveInFlight;
      if (inFlight !== null) {
        // Wait, but not forever: a narrated Ceremony runs for minutes, longer than
        // any container's shutdown grace period, and being SIGKILLed halfway is worse
        // than exiting cleanly. A row left in flight is recovered on the next start.
        log.info("waiting for the ceremony in progress before shutting down", { signal });
        console.error("\nFinishing the ceremony in progress before stopping…");
        const finished = await withTimeout(inFlight.then(() => true), SHUTDOWN_WAIT_MS, false);
        if (!finished) log.warn("shutting down with a ceremony still in progress; it will be recovered on next start");
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
  const log = createLogger(env.logLevel ?? config.logging.level);

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
    const prompt = loadPrompt(config.llm.promptPath);
    const provider =
      env.openrouterApiKey === null
        ? null
        : rateLimited(openRouterProvider({ apiKey: env.openrouterApiKey, model: config.llm.model }), {
            minIntervalMs: config.llm.minRequestIntervalMs,
          });
    const biggestHelmetId = config.helmets.reduce((a, b) => (b.rank > a.rank ? b : a)).id;
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

      /**
       * Recency of a member's last message, as a selection weight. Read fresh at
       * ceremony time, and uniform when weighting is off or nothing is recorded yet
       * — so a fresh install behaves exactly as it did before this existed.
       */
      const weightForMember = () => {
        const weighting = config.participants.activityWeighting;
        if (!weighting.enabled) return undefined;
        const now = Date.now();

        // Sightings older than the widest tier carry no information — they weigh the
        // same as never having been seen — so they are dropped rather than kept
        // forever in a guild that turns over its membership.
        const widestDays = Math.max(0, ...weighting.tiers.map((t) => t.withinDays));
        const forgotten = store.forgetMemberActivityBefore(env.discordGuildId, now - widestDays * 86_400_000);
        if (forgotten > 0) log.info("forgot stale member activity", { rows: forgotten });

        const seen = store.memberActivity(env.discordGuildId);
        return (member: Member) =>
          activityWeight(seen.get(member.id) ?? null, now, weighting.tiers, weighting.dormantWeight);
      };

      /**
       * Performs the Ceremony aloud. The application decides what happened and
       * hands over only the facts; the model supplies the words, and static lines
       * take over when it cannot. Beats are spaced so the roles visibly change
       * mid-ritual instead of all at once in silence.
       */
      const narrator = () => {
        const narration = config.ceremony.narration;
        if (!narration.enabled || config.development.dryRun) return undefined;

        const delays = beatDelays(
          BEATS.length,
          narration.minSpanMinutes * 60_000,
          narration.maxSpanMinutes * 60_000,
          cryptoRandom,
        );
        const beatOf: Partial<Record<string, Beat>> = {
          EPIPHANY: "epiphany",
          SUMMON: "summon",
          COLLECTION: "summon",
          BARREL: "barrel",
          REDISTRIBUTION: "redistribution",
          AFTERMATH: "aftermath",
        };
        let spoken = 0;

        return async (state: string, facts: string): Promise<void> => {
          const beat = beatOf[state];
          // COLLECTION shares the summoning beat: taking the helmets back is the
          // same moment, and six announcements is already the ceiling.
          if (beat === undefined || state === "COLLECTION") return;

          if (spoken > 0) {
            const wait = delays[spoken - 1] ?? 0;
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          }
          spoken++;

          // The static line is the floor. Everything below may fail or time out; the
          // beat is still performed, because a Ceremony that goes silent halfway is
          // worse than one that is worded plainly.
          let message = FALLBACK_BEATS[beat];
          const channelId = await withTimeout(ceremonyChannel(), BEAT_TIMEOUT_MS, null);
          if (channelId === null) {
            log.warn("ceremony beat had nowhere to go", { beat });
            return;
          }

          if (provider !== null) {
            const spokenLine = await withTimeout(
              (async () => {
                const situation = await pakledSituation(
                  guild,
                  client.user.id,
                  config.helmets,
                  helmetRoleMap(config.helmets, store.helmetRoles(env.discordGuildId)),
                  "the ceremony",
                  store.currentHolderOf(env.discordGuildId, biggestHelmetId) ?? null,
                  store.currentMultihat(env.discordGuildId) ?? null,
                );
                return parseSpoken(await provider.complete(ceremonyRequest(prompt, situation, beat, facts)), message);
              })().catch(() => ({ message, usedFallback: true })),
              BEAT_TIMEOUT_MS,
              { message, usedFallback: true },
            );
            if (spokenLine.usedFallback) log.warn("ceremony beat used a fallback line", { beat });
            message = spokenLine.message;
          }

          const sent = await withTimeout(
            sendTo(guild, channelId, message, (reason) => log.warn("could not send a ceremony beat", { beat, reason })),
            BEAT_TIMEOUT_MS,
            false,
          );
          if (sent) {
            store.recordBotMessage(env.discordGuildId, channelId, Date.now());
            log.info("ceremony beat spoken", { beat });
          } else {
            log.warn("ceremony beat could not be sent", { beat });
          }
        };
      };

      /** Where the Ceremony is performed: configured, or wherever people are talking. */
      const ceremonyChannel = async (): Promise<string | null> => {
        const allowed = speakableChannels(guild, client.user.id).filter((c) =>
          channelAllowed(c.id, { deny: config.channels.deny, adminChannelId: config.channels.adminChannelId }, c.parentId),
        );
        // A configured channel is honoured only if it is real, speakable and not
        // excluded. Silently losing every announcement to a deleted or admin channel
        // is worse than performing the Ceremony somewhere else.
        const configured = config.channels.ceremonyChannelId;
        if (configured !== null) {
          if (allowed.some((c) => c.id === configured)) return configured;
          log.warn("configured ceremony channel is unusable; performing elsewhere", { channelId: configured });
        }

        const known = new Map(store.channelActivity(env.discordGuildId).map((a) => [a.channelId, a]));
        const busiest = allowed
          .map((c) => known.get(c.id))
          .filter((a): a is NonNullable<typeof a> => a !== undefined)
          .sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
        return busiest?.channelId ?? allowed[0]?.id ?? null;
      };

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
          weightOf: weightForMember(),
          narrate: narrator(),
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

      await runDaemon({
        client,
        guildId: env.discordGuildId,
        config,
        store,
        log,
        ceremony,
        prompt,
        guild,
        provider,
        biggestHelmetId,
      });
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
