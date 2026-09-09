import { readFileSync } from "node:fs";
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
import { Events, PermissionsBitField, type Guild, type Message } from "discord.js";
import {
  announce,
  connect,
  DisallowedIntentsError,
  listMembers,
  listRoles,
  helmetByRole,
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
import { chattiness, NO_MOOD, seedFor, type Mood } from "./moods.ts";
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
import { createDebugStream, tee } from "./debugdm.ts";
import type { CeremonyEffects } from "./ceremony.ts";
import { checkReadiness, type ReadinessReport } from "./readiness.ts";
import { handleCommands, parseDuration, registerCommands } from "./commands.ts";
import { generateMention, durationSubject, channelAllowed, createCooldown, reduceHistory, reduceOptionalHistory, optionalHistorySources, sanitizeMentionQuestion, type RawMessage } from "./mentions.ts";
import {
  meetsActivityFloor,
  nextPassiveDelay,
  selectActiveChannel,
  shouldConsiderSpeaking,
  type ActivityEvent,
} from "./passive.ts";
import { isAddressedToBot } from "./addressing.ts";
import { createEngagementState, type EngagementToken } from "./engagement.ts";
import { ceremonyRequest, interjectionRequest } from "./voice.ts";
import { afterFailure, afterSuccess, circuitBroken, isDue, type Schedule } from "./schedule.ts";
import { runCeremony, type CeremonyRun } from "./run.ts";
import { nextCeremonyLine, relative, diagnosticsReport, whereReport, type StatusView } from "./status.ts";
import { openStore, type Store } from "./store.ts";
import { historyContext, historyDurationReply, requestedHelmet } from "./history-context.ts";
import { createMemory, type Recall } from "./memory.ts";
import { discordMemoryAccess } from "./memory-access.ts";
import { memoryCommands } from "./memory-commands.ts";

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
  /**
   * False when the guild is not set up correctly. The Pakled still talks; it simply
   * has no helmets to move and nothing to be suspicious about.
   */
  canManageRoles: boolean;
}): Promise<void> => {
  const { client, guildId, config, store, log, ceremony, guild, canManageRoles } = args;
  // Ceremonies need roles. With role management off the plan is switched off too,
  // which the character already has a way of saying.
  const timing = { ...config.ceremony, enabled: config.ceremony.enabled && canManageRoles };
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

  /**
   * What the standing Ceremony left the Pakled feeling. Read fresh every time rather
   * than cached: a Ceremony can complete while the process is up, and a mood held in
   * a variable would be a day out of date.
   */
  const standingMood = (): { mood: Mood; sinceMs: number | null } => {
    const outcome = store.lastOutcome(guildId);
    if (outcome === undefined) return { mood: NO_MOOD, sinceMs: null };
    return {
      mood: {
        helmetless: outcome.pakledWentWithout,
        coveting: outcome.covetedHelmetId !== undefined,
        multihat: outcome.multihatMemberId !== undefined,
      },
      sinceMs: outcome.completedAt === null ? null : Date.now() - outcome.completedAt,
    };
  };

  /** The two mood facts pakledSituation needs, resolved against who holds what now. */
  const moodFacts = (): {
    coveted: { helmetId: string; memberId: string | null } | null;
    wentWithout: boolean;
  } => {
    const outcome = store.lastOutcome(guildId);
    if (outcome === undefined) return { coveted: null, wentWithout: false };
    const helmetId = outcome.covetedHelmetId;
    return {
      coveted:
        helmetId === undefined
          ? null
          : { helmetId, memberId: store.currentHolderOf(guildId, helmetId) ?? null },
      wentWithout: outcome.pakledWentWithout,
    };
  };

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
        `The plan went wrong ${next.consecutiveFailures} times. I have stopped trying. Tell me to resume.`,
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
    else if (!canManageRoles) log.warn("no ceremony is scheduled: role management is disabled");
    else log.warn("ceremonies are disabled by configuration; none will be scheduled");
  } else {
    log.info("resuming existing schedule", {
      ...describe(existing),
      circuitBroken: circuitBroken(existing, timing.maxConsecutiveFailures),
    });
  }

  const { provider, biggestHelmetId } = args;
  const historyUsed = new Map<string, number>();
  const memoryAccess = discordMemoryAccess(guild, config);
  const memory = createMemory({ guildId, config, store, access: memoryAccess, provider,
    onSkip: () => log.debug("personal memory skipped unavailable or invalid work") });
  const sweepMemory = () => {
    try { store.sweepMemory(Date.now(), config.memory.retentionDays); }
    catch { log.warn("personal memory expiry cleanup failed"); }
  };
  sweepMemory();
  const memoryTimer = setInterval(sweepMemory, 3600000);
  const memoryWork = new Set<Promise<void>>();
  const learn = (messages: RawMessage[], channelId: string) => {
    if (stopping || !config.memory.enabled) return;
    // Preprocessing is dispensable too; do not accumulate raw contexts before the provider queue.
    if (memoryWork.size >= 2) return;
    const work = memory.learn(messages, channelId);
    memoryWork.add(work);
    void work.finally(() => memoryWork.delete(work));
  };
  const activity = new Map<string, ActivityEvent[]>();
  const engagement = createEngagementState({
    attentionIdleMs: config.conversation.engagement.idleMinutes * 60_000,
    attentionMaxMs: config.conversation.engagement.maxMinutes * 60_000,
    optionalCooldownMs: config.conversation.passive.channelCooldownMinutes * 60_000,
  });
  const followupTimers = new Map<string, NodeJS.Timeout>();
  let answering = 0;
  let classifying = 0;
  const directWork = new Set<Promise<void>>();
  const allowed = (channelId: string, parentId?: string | null): boolean =>
    channelAllowed(channelId, { deny: config.channels.deny, adminChannelId: config.channels.adminChannelId }, parentId);
  const runOptional = (work: () => Promise<void>): void => {
    if (stopping || passiveInFlight !== null || answering > 0 || provider === null) {
      log.debug("optional conversation deferred", { stopping, answering, optionalBusy: passiveInFlight !== null, providerAvailable: provider !== null });
      return;
    }
    passiveInFlight = work()
      .catch((cause: unknown) => log.error("optional conversation failed", { reason: (cause as Error).message }))
      .finally(() => { passiveInFlight = null; });
  };
  const scheduleFollowup = (channelId: string): void => {
    const previous = followupTimers.get(channelId);
    if (previous !== undefined) clearTimeout(previous);
    followupTimers.delete(channelId);
    if (stopping || !config.conversation.engagement.enabled || provider === null ||
        !engagement.snapshot(channelId, Date.now()).attention) return;
    // One timer per channel; an overloaded bot drops optional work, never queues it.
    if (followupTimers.size >= 256) return;
    const timer = setTimeout(() => {
      followupTimers.delete(channelId);
      runOptional(async () => {
        const token = engagement.claim(channelId, Date.now(), true);
        if (token !== null) await speakOptional(token);
      });
    }, config.conversation.engagement.quietSeconds * 1000);
    followupTimers.set(channelId, timer);
  };
  const floorWindowMs = config.conversation.passive.activityFloor.windowMinutes * 60_000;

  // Every human message counts toward the activity floor and channel scoring,
  // whether or not mentions are answered: passive conversation is configured
  // independently and must not be disabled by proxy.
  client.on(Events.MessageCreate, (message) => {
    if (stopping || message.guildId !== guildId) return;
    if (message.author.bot) {
      if (message.author.id === client.user.id) engagement.onBotReply(message.channelId, Date.now());
      return;
    }
    try {
      // Ceremony participation still counts people talking in excluded chat channels.
      store.recordMemberActivity(guildId, message.author.id, message.createdTimestamp);
    } catch (cause) {
      log.error("could not record member activity", { reason: (cause as Error).message });
    }
    const parentId = "parentId" in message.channel ? message.channel.parentId : null;
    if (!allowed(message.channelId, parentId)) return;
    const possiblyDirect = config.conversation.mentionEnabled &&
      (message.mentions.users.has(client.user.id) || message.reference?.messageId !== undefined);
    engagement.onHuman({ channelId: message.channelId, messageId: message.id, at: Date.now(), direct: possiblyDirect });
    const timer = followupTimers.get(message.channelId);
    if (timer !== undefined) clearTimeout(timer);
    followupTimers.delete(message.channelId);
    if (!possiblyDirect) scheduleFollowup(message.channelId);
    try {
      // Timestamps only — who was around and when. No content.
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
    client.on(Events.MessageCreate, (message) => {
      // Nothing may escape: the emitter cannot observe this promise.
      const work = (async () => {
        if (stopping || message.author.bot || message.guildId !== guildId) return;
        const parentId = "parentId" in message.channel ? message.channel.parentId : null;
        if (!allowed(message.channelId, parentId)) return;
        const receivedAt = Date.now();
        const mentioned = message.mentions.users.has(client.user.id);
        const reference = message.reference;
        if (!mentioned && reference?.messageId === undefined) return;
        // Classification is bounded separately: human-to-human replies must not
        // occupy all the slots reserved for actual direct answers.
        let addressed: boolean | null = true;
        if (!mentioned) {
          if (classifying >= config.conversation.maxConcurrentMentions) {
            log.debug("reply classification at capacity; leaving input as ordinary chat", { channelId: message.channelId });
            engagement.markDirect(message.channelId, message.id, false);
            scheduleFollowup(message.channelId);
            return;
          }
          classifying++;
          try { addressed = await isAddressedToBot(message, client.user.id); }
          finally { classifying--; }
        }
        if (!addressed) {
          // No direct answer is attempted after an unverifiable target. Let the
          // new input remain ordinary chat instead of permanently labeling it direct.
          engagement.markDirect(message.channelId, message.id, false);
          scheduleFollowup(message.channelId);
          if (addressed === null) log.debug("could not verify reply target", { channelId: message.channelId });
          return;
        }
        if (stopping || answering >= config.conversation.maxConcurrentMentions) return;
        answering++;
        try {
          engagement.markDirect(message.channelId, message.id, true);
          log.debug("directly addressed", { userId: message.author.id, channelId: message.channelId });
          await respondToMention(message, receivedAt);
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
      directWork.add(work);
      void work.finally(() => directWork.delete(work));
    });

    const respondToMention = async (message: Message, receivedAt: number): Promise<void> => {
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
        let recall: Recall = { text: "", notes: [], generations: new Map() };
        const generated = await generateMention({
          channelId: message.channelId,
          parentId: parent,
          userId: message.author.id,
          question: sanitizeMentionQuestion({
            rawContent: message.content,
            cleanContent: message.cleanContent,
            botId: client.user.id,
            botNames: [guild.members.me?.displayName ?? client.user.displayName, client.user.displayName],
          }),
          factualReply: async () => {
            if (!/\bhow (?:long|many (?:days|hours|minutes|weeks|months|years))\b/i.test(message.cleanContent)) return null;
            const helmet = requestedHelmet(config, message.cleanContent);
            if (helmet === undefined) return null;
            if (helmet === null) return "Which helmet do you mean? There is more than one.";
            const mentioned = [...message.mentions.users.keys()].filter((id) => id !== client.user.id);
            const subject = durationSubject(message.cleanContent, message.author.id, mentioned);
            if (!subject) return "Mention the member whose recorded helmet run you mean. I will look at the records.";
            return historyDurationReply(guild, store, helmet.id, subject, Date.now(), helmet.name);
          },
          now: Date.now(),
          channels: { deny: config.channels.deny, adminChannelId: config.channels.adminChannelId },
          userCooldown: cooldown,
          channelCooldown,
          history: async () =>
            reduceHistory(
              memory.filterHistory(await recentMessages(
                message.channel,
                config.conversation.mentionContextMessages,
                message.id,
                helmetByRole(config.helmets, helmetRoleMap(config.helmets, store.helmetRoles(guildId))),
              )),
              config.conversation.mentionContextMessages,
            ),
          asker: {
            name: message.member?.displayName ?? message.author.displayName,
            mentionedPeople: [...message.mentions.users.values()]
              .filter((user) => user.id !== client.user.id)
              .flatMap((user) => {
                const member = guild.members.cache.get(user.id);
                // Unknown roles are omitted rather than asserted to be helmetless.
                return member === undefined ? [] : [{
                  name: member.displayName,
                  helmet: helmetByRole(config.helmets, helmetRoleMap(config.helmets, store.helmetRoles(guildId)))([...member.roles.cache.keys()]),
                }];
              }),
            replyTo: message.reference?.messageId === undefined
              ? null
              : message.channel.messages.cache.get(message.reference.messageId)?.author.displayName ?? null,
            helmet:
              message.member === null
                ? null
                : helmetByRole(
                    config.helmets,
                    helmetRoleMap(config.helmets, store.helmetRoles(guildId)),
                  )([...message.member.roles.cache.keys()]),
          },
          context: async () => {
            const facts = moodFacts();
            const situation = await pakledSituation(
              message.guild!,
              client.user.id,
              config.helmets,
              helmetRoleMap(config.helmets, store.helmetRoles(guildId)),
              "name" in message.channel ? (message.channel.name ?? "here") : "here",
              store.currentHolderOf(guildId, biggestHelmetId) ?? null,
              store.currentMultihat(guildId) ?? null,
              facts.coveted,
              facts.wentWithout,
            );
            const helmet = requestedHelmet(config, message.cleanContent);
            situation.history = helmet ? await historyContext(guild, store, helmet.id,
              [message.author.id, ...message.mentions.users.keys()].filter((id) => id !== client.user.id), Date.now(), helmet.name)
              : helmet === null ? "Several helmet subjects were mentioned. Ask which helmet they mean rather than selecting one." : "";
            recall = await memory.recall([message.author.id], message.channelId, Date.now());
            situation.memories = recall.text;
            return situation;
          },
          canGenerate: () => memory.validate(recall, message.channelId),
          provider,
          prompt: args.prompt,
          fallback: () => fallbackLine((max) => cryptoRandom.int(max)),
          onFallback: (reason) => log.warn("answered with a fallback line", { reason }),
          onDecline: (reason) =>
            log.debug("stayed quiet", { reason, userId: message.author.id, channelId: message.channelId }),
          onThinking: showTyping,
        });

        if (generated === null || stopping || !allowed(message.channelId, parent)) return;
        const authorized = await memory.validate(recall, message.channelId);
        if (stopping || !allowed(message.channelId, parent)) return;
        const valid = authorized && memory.valid(recall);
        // No await between final local invalidation check and Discord invocation.
        await message.reply({ content: valid ? generated.message : fallbackLine((max) => cryptoRandom.int(max)),
          allowedMentions: { repliedUser: true, parse: [] } });
        if (valid && !generated.usedFallback) {
          memory.used(recall, Date.now());
          learn([{ messageId: message.id, authorId: message.author.id, authorIsBot: false,
            authorName: message.member?.displayName ?? message.author.displayName,
            content: message.cleanContent, createdTimestamp: message.createdTimestamp }], message.channelId);
        }
        engagement.onDirectReply({ channelId: message.channelId, inputAt: receivedAt, now: Date.now() });
        store.recordBotMessage(guildId, message.channelId, Date.now());
      } finally {
        if (typing !== null) clearInterval(typing);
      }
    };
  }

  // Both optional paths share generation and the last check before Discord delivery.
  const speakOptional = async (token: EngagementToken): Promise<void> => {
    const { channelId } = token;
    const declined = (reason: string): false => {
      log.debug("optional conversation declined", { channelId, reason });
      return false;
    };
    const stillCurrent = (checkChannel = true): boolean => {
      if (stopping || answering > 0 || !engagement.isCurrent(token, Date.now())) return declined("stopped, direct answer in progress, or input changed/expired");
      const latestSourceAt = activity.get(channelId)?.at(-1)?.at;
      if (!token.continuation && (latestSourceAt === undefined ||
          Date.now() - latestSourceAt > config.conversation.passive.maxIdleMinutes * 60_000)) return declined("conversation went stale");
      if (!checkChannel) return true;
      if (!token.continuation) {
        return speakableChannels(guild, client.user.id).some((c) => c.id === channelId && allowed(c.id, c.parentId)) || declined("channel no longer speakable or allowed");
      }
      // Invited conversation can continue in a thread even though passive wandering
      // deliberately chooses ordinary text channels only.
      const current = guild.channels.cache.get(channelId);
      if (current === undefined || !current.isTextBased() || !allowed(current.id, current.parentId)) return declined("channel unavailable or denied");
      if (current.isThread() && current.archived) return declined("thread archived");
      const permissions = current.permissionsFor(client.user.id);
      return permissions !== null && permissions.has(PermissionsBitField.Flags.ViewChannel) &&
        permissions.has(current.isThread() ? PermissionsBitField.Flags.SendMessagesInThreads : PermissionsBitField.Flags.SendMessages) || declined("channel permissions do not allow speech");
    };
    if (provider === null) { declined("no provider"); return; }
    if (!stillCurrent(false)) return;
    const channel = await guild.channels.fetch(channelId);
    if (channel === null || !channel.isTextBased()) { declined("channel missing or not text-based"); return; }
    if (!stillCurrent()) return;
    const sources = optionalHistorySources(await recentMessages(channel, config.conversation.mentionContextMessages, undefined,
      helmetByRole(config.helmets, helmetRoleMap(config.helmets, store.helmetRoles(guildId)))), token.messageId, config.conversation.mentionContextMessages);
    if (sources === null) { declined("claimed input superseded or non-text"); return; }
    const rawHistory = memory.filterHistory(sources);
    const history = reduceOptionalHistory(rawHistory, token.messageId, config.conversation.mentionContextMessages);
    if (history === null || history.length === 0) { declined("claimed input missing, non-text, or superseded in fetched history"); return; }
    if (!stillCurrent()) return;
    const facts = moodFacts();
    const situation = await pakledSituation(
      guild, client.user.id, config.helmets, helmetRoleMap(config.helmets, store.helmetRoles(guildId)),
      "name" in channel ? (channel.name ?? "here") : "here",
      store.currentHolderOf(guildId, biggestHelmetId) ?? null,
      store.currentMultihat(guildId) ?? null, facts.coveted, facts.wentWithout,
    );
    if (!stillCurrent()) return;
    const nudge = seedFor(standingMood().mood, cryptoRandom);
    const historicSubject = [...history].reverse().find((m) => !m.isBot);
    const historyMember = rawHistory.findLast((m) => !m.authorIsBot)?.authorId;
    if (historyMember && historicSubject && /helmet|barrel|leader/i.test(historicSubject.content) &&
      Date.now() - (historyUsed.get(historyMember) ?? -Infinity) >= 86400000) {
      situation.history = await historyContext(guild, store, biggestHelmetId, [historyMember], Date.now(), config.helmets.find((h) => h.id === biggestHelmetId)!.name);
    }
    const recall = await memory.recall(rawHistory.filter((m) => !m.authorIsBot).flatMap((m) => m.authorId ? [m.authorId] : []), channelId, Date.now());
    situation.memories = recall.text;
    if (!stillCurrent()) return;
    log.debug("considering optional conversation", { channelId, continuation: token.continuation });
    const decision = parseInterjection(
      await provider.complete(interjectionRequest(args.prompt, situation, history, nudge, token.continuation),
        { authorize: async () => stillCurrent() && await memory.validate(recall, channelId) && stillCurrent() && memory.valid(recall) }),
    );
    if (!decision.shouldRespond || decision.response === undefined) {
      log.debug("optional conversation: stayed silent", { channelId });
      return;
    }
    if (!await memory.validate(recall, channelId)) return;
    const spoken = await sendTo(guild, channelId, decision.response,
      (reason) => log.warn("could not speak optionally", { channelId, reason }), () => stillCurrent() && memory.valid(recall));
    if (spoken) {
      memory.used(recall, Date.now());
      if (config.memory.learning === "expanded") learn(rawHistory, channelId);
      if (situation.history && historyMember) {
        for (const [id, at] of historyUsed) if (Date.now() - at >= 86400000) historyUsed.delete(id);
        historyUsed.set(historyMember, Date.now());
      }
      engagement.onBotReply(channelId, Date.now(), "optional");
      store.recordOptionalMessage(guildId, channelId, Date.now());
      log.info("spoke optionally", { channelId, continuation: token.continuation });
    }
  };

  if (config.conversation.passive.enabled) {
    const passive = config.conversation.passive;
    const cycle = async (): Promise<void> => {
      const now = Date.now();
      engagement.prune(now);
      for (const [id, events] of activity) {
        const live = events.filter((e) => now - e.at <= floorWindowMs);
        if (live.length === 0) activity.delete(id);
        else activity.set(id, live);
      }
      const speakable = new Set(speakableChannels(guild, client.user.id)
        .filter((c) => allowed(c.id, c.parentId)).map((c) => c.id));
      const known = store.channelActivity(guildId);
      const candidates = known.filter((a) => {
        const state = engagement.snapshot(a.channelId, now);
        return speakable.has(a.channelId) && state.latestHuman !== null && !state.latestHuman.direct &&
          state.consumedMessageId !== state.latestHuman.messageId &&
          (state.lastBotAt === null || state.latestHuman.at > state.lastBotAt) &&
          !(config.conversation.engagement.enabled && state.attention) &&
          now - a.lastMessageAt <= passive.maxIdleMinutes * 60_000 &&
          (a.lastOptionalMessageAt === null || now - a.lastOptionalMessageAt >= passive.channelCooldownMinutes * 60_000) &&
          meetsActivityFloor(activity.get(a.channelId) ?? [], now, passive.activityFloor);
      });
      const channelId = selectActiveChannel(candidates, now, cryptoRandom);
      if (channelId === null) {
        log.debug("passive cycle: no fresh, unhandled conversation clears the entry gates", {
          speakable: speakable.size, known: known.length, windowMinutes: passive.activityFloor.windowMinutes,
          needMessages: passive.activityFloor.minMessages, needAuthors: passive.activityFloor.minDistinctAuthors,
        });
        return;
      }
      // Consume before chance, too: unchanged input does not get a new roll each cycle.
      const token = engagement.claim(channelId, now);
      if (token === null) return;
      const chosen = candidates.find((c) => c.channelId === channelId)!;
      const gates = shouldConsiderSpeaking({
        events: activity.get(channelId) ?? [], now, floor: passive.activityFloor,
        lastBotMessageAt: chosen.lastOptionalMessageAt,
        channelCooldownMinutes: passive.channelCooldownMinutes, maxIdleMinutes: passive.maxIdleMinutes,
        probability: passive.probability,
      }, cryptoRandom);
      if (!gates.speak) {
        log.debug("passive cycle: gates declined", { channelId, ...gates });
        return;
      }
      await speakOptional(token);
    };
    const schedulePassive = (): void => {
      if (stopping) return;
      const { mood, sinceMs } = standingMood();
      const multiplier = chattiness(mood, sinceMs);
      const delay = Math.round(nextPassiveDelay(passive.minIntervalMinutes, passive.maxIntervalMinutes, cryptoRandom) / multiplier);
      log.info("next passive cycle", { inMinutes: Math.round(delay / 60_000) });
      passiveTimer = setTimeout(() => {
        runOptional(cycle);
        schedulePassive();
      }, delay);
    };
    schedulePassive();
  }

  // Share in-flight lookups and bound public gateway member requests to once per 30 seconds.
  let holderMembers: ReturnType<typeof guild.members.fetch> | undefined;
  let holderMembersAt = 0;
  /** Schedule and diagnostics are fresh; public holder snapshots last at most 30 seconds. */
  const currentView = async (includeHolders = false): Promise<StatusView> => {
    const roleByHelmet = helmetRoleMap(config.helmets, store.helmetRoles(guildId));
    if (includeHolders && (!holderMembers || Date.now() - holderMembersAt >= 30_000)) {
      holderMembersAt = Date.now();
      holderMembers = guild.members.fetch();
      // Keep a rejected lookup for the same cooldown so failures cannot trigger a request storm.
    }
    const members = includeHolders ? await holderMembers! : null;
    const holders = config.helmets.map((helmet) => {
      const roleId = roleByHelmet.get(helmet.id);
      const labels = roleId === undefined ? [] : [...(members?.values() ?? [])]
        .filter((member) => member.roles.cache.has(roleId)).map((member) => member.displayName);
      return { helmetName: helmet.name, rank: helmet.rank, memberLabel: labels.length ? labels.join(", ") : null };
    });
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

  /** A mention that renders, without granting the bot the power to ping anyone:
   *  every reply is sent with allowedMentions parse: []. */
  const mention = (userId: string): string => `<@${userId}>`;

  /** A timestamp is not something the character can say. How long is left is. */
  const untilWhen = (at: number): string => `I stop ${relative(Date.now(), at)}`;

  let inFlight: Promise<void> | null = null;

  /**
   * A Ceremony and everything that must follow it: rescheduling, the failure count
   * and the circuit breaker. Shared by the clock and by /helmet ceremony, so an
   * on-demand run is the same event as a due one and not a second code path.
   */
  const performCeremony = async (): Promise<void> => {
    const current = store.schedule(guildId);
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

  /**
   * Starts one if none is running. Returns whether it started, so a caller can say
   * so — the clock does not care, but somebody who typed a command does.
   *
   * Nothing may escape as an unhandled rejection: an interval callback cannot
   * observe one, and it would take the process down.
   */
  const begin = (): boolean => {
    if (inFlight !== null) return false;
    inFlight = performCeremony()
      .catch((cause: unknown) => log.error("ceremony run failed", { reason: (cause as Error).message }))
      .finally(() => void (inFlight = null));
    return true;
  };

  await registerCommands(client, guildId);
  handleCommands(
    client,
    guildId,
    {
    ...memoryCommands({ guildId, config, store, access: memoryAccess,
      mayInspect: async (id) => (await guild.fetch()).ownerId === id || store.isAdmin(guildId, id) }),
    status: async ({ caller }) => {
      const view = await currentView();
      // Recheck after asynchronous reads, before disclosing diagnostics.
      const owner = (await guild.fetch()).ownerId;
      if (owner !== caller.userId && !store.isAdmin(guildId, caller.userId)) return "Only a leader may see this.";
      const counts = store.memoryStats(guildId, Date.now(), config.memory.retentionDays);
      const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
      return diagnosticsReport(view, [
        `Deployed package: ${version}; uptime: ${Math.floor(process.uptime())} seconds`,
        `Passive: ${config.conversation.passive.enabled ? "enabled" : "disabled"}; optional work active: ${passiveInFlight !== null}; direct replies active: ${answering}`,
        `Activity channels tracked: ${activity.size}; recent events: ${[...activity.values()].reduce((n, events) => n + events.filter((e) => Date.now() - e.at <= floorWindowMs).length, 0)}`,
        `Memory: ${config.memory.enabled ? "enabled" : "disabled"}; ${config.memory.learning}; ${config.memory.scope}; retention: ${config.memory.retentionDays} days; cap: ${config.memory.maxNotes}/member`,
        `Memory stores: SQLite topic_notes + memory_controls (this guild); notes stored: ${counts.stored}; unexpired: ${counts.active}; members with notes: ${counts.members}; opted out: ${counts.disabled}; learning jobs: ${memoryWork.size}`,
      ]);
    },
    "helmets where": async ({ page }) => whereReport(await currentView(true), page),
    next: async () => nextCeremonyLine(await currentView()),
    roles: async ({ page }) => whereReport(await currentView(true), page),
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

    ceremony: () => {
      // The same refusals the clock respects. An on-demand Ceremony is a convenience,
      // not a way around a pause or a tripped breaker.
      if (!canManageRoles) return "I cannot move the helmets today. Something about this place is wrong.";
      if (!timing.enabled) return "The helmet plan is switched off. This is not my decision.";
      const schedule = store.schedule(guildId);
      if (schedule.paused) return "Someone told me to stop. Tell me to continue first.";
      if (circuitBroken(schedule, timing.maxConsecutiveFailures)) {
        return `The plan is broken. It failed ${schedule.consecutiveFailures} times. Tell me to resume first.`;
      }
      // Deliberately not awaited: a narrated Ceremony runs for minutes, and Discord
      // stops listening to an interaction long before that.
      return begin()
        ? "Everyone will give back the helmets. This is not a request. I am the leader."
        : "A ceremony is happening now. Do not touch the helmets.";
    },

    "admin add": ({ caller, targetUserId }) => {
      if (targetUserId === null) return "You did not say who.";
      if (targetUserId === guild.ownerId) return "They own this place. They already do what they like.";
      if (targetUserId === client.user.id) return "I am already myself.";
      store.addAdmin(guildId, targetUserId, caller.userId);
      log.info("a bot admin was appointed", { userId: targetUserId, by: caller.userId });
      return `${mention(targetUserId)} can tell me what to do now.`;
    },
    "admin remove": ({ targetUserId }) => {
      if (targetUserId === null) return "You did not say who.";
      const removed = store.removeAdmin(guildId, targetUserId);
      if (removed) log.info("a bot admin was dismissed", { userId: targetUserId });
      // The log stream is a power an admin was given; it goes with the appointment.
      if (removed) store.unsubscribeDebug(guildId, targetUserId);
      return removed
        ? `${mention(targetUserId)} does not tell me what to do any more.`
        : "They were not telling me what to do.";
    },
    "admin list": () => {
      const admins = store.admins(guildId);
      const lines = [`${mention(guild.ownerId)} owns this place. I do what they say.`];
      if (admins.length === 0) lines.push("Nobody else tells me what to do.");
      else {
        lines.push("These ones also tell me what to do:");
        for (const a of admins) lines.push(mention(a.userId));
      }
      return lines.join("\n");
    },

    "debug-dm enable": async ({ caller, targetUserId, expiration }) => {
      const recipient = targetUserId ?? caller.userId;
      // Only somebody who may already steer the bot may be sent its logs: they
      // carry channel ids, user ids and failure reasons.
      if (recipient !== guild.ownerId && !store.isAdmin(guildId, recipient)) {
        return "They do not tell me what to do. Say that they can, first.";
      }
      const ms = expiration === null ? 3_600_000 : parseDuration(expiration);
      if (ms === null) return "I do not understand that much time. Say it like 90m, or 2h, or 3d, or 1y.";

      // Proven before it is promised: a closed DM fails here rather than silently
      // for the next three days.
      try {
        await (await client.users.fetch(recipient)).send("I will tell you what I am doing.");
      } catch {
        return "I cannot talk to them. They do not let me send them things.";
      }
      const expiresAt = Date.now() + ms;
      store.subscribeDebug(guildId, recipient, expiresAt);
      log.info("debug direct messages enabled", { userId: recipient, expiresAt, by: caller.userId });
      return `I will tell ${mention(recipient)} what I am doing. ${untilWhen(expiresAt)}.`;
    },
    "debug-dm disable": ({ caller, targetUserId }) => {
      const recipient = targetUserId ?? caller.userId;
      const stopped = store.unsubscribeDebug(guildId, recipient);
      if (stopped) log.info("debug direct messages disabled", { userId: recipient, by: caller.userId });
      return stopped ? `I will stop telling ${mention(recipient)} things.` : "I was not telling them anything.";
    },
    "debug-dm status": () => {
      const subscribers = store.debugSubscribers(guildId, Date.now());
      if (subscribers.length === 0) return "I am not telling anyone what I am doing.";
      return subscribers.map((s) => `${mention(s.userId)} — ${untilWhen(s.expiresAt)}.`).join("\n");
    },
    },
    (userId) => userId === guild.ownerId || store.isAdmin(guildId, userId),
    (msg, cause) => log.error(msg, { reason: cause.message }),
  );

  const tick = (): void => {
    const schedule = store.schedule(guildId);
    if (!timing.enabled || !isDue(schedule, Date.now(), timing)) return;
    begin();
  };

  const timer = setInterval(tick, timing.checkIntervalSeconds * 1000);
  log.info("running", { checkIntervalSeconds: timing.checkIntervalSeconds });
  console.error("\nRunning. The Pakled is waiting. Ctrl-C to stop.");

  await new Promise<void>((resolve) => {
    const stop = async (signal: string) => {
      stopping = true;
      clearInterval(timer);
      clearInterval(memoryTimer);
      if (passiveTimer !== null) clearTimeout(passiveTimer);
      for (const timer of followupTimers.values()) clearTimeout(timer);
      followupTimers.clear();
      // Clearing the timer cannot stop a cycle that has already fired, and it would
      // otherwise keep running against a closed store and a destroyed client.
      // Bounded, like the ceremony wait below it: a cycle stuck on a network call
      // must not hold shutdown open for as long as the connection lives.
      await withTimeout(Promise.allSettled([
        ...directWork,
        ...memoryWork,
        ...(passiveInFlight === null ? [] : [passiveInFlight]),
      ]).then(() => true), SHUTDOWN_WAIT_MS, false);
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
  // Reassigned once the store and the client exist, so the log can also be sent to
  // whoever asked for it. Everything logged before that point predates any
  // subscriber and has nowhere to go anyway.
  let log = createLogger(env.logLevel ?? config.logging.level);

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

    // A guild that is not set up correctly costs the bot its roles, not its voice.
    // Conversation needs no role management at all, so a hierarchy problem disables
    // one feature and leaves a Pakled with nothing to be suspicious about — which is
    // still a Pakled.
    const canManageRoles = before.ok;
    if (!canManageRoles) {
      for (const problem of before.problems) log.error(problem);
      log.error("role management disabled: guild is not ready");
      // A one-shot Ceremony has nothing to degrade into.
      if (command !== "start") {
        render("NOT READY — role management disabled, nothing was changed", before);
        return 1;
      }
    }

    if (!config.enabled) {
      log.warn("disabled by configuration: no roles will be created, renamed or deleted");
      render("DISABLED — nothing was changed", before);
      return 0;
    }

    const store = openStore(join(env.dataDir, "bot.sqlite"));

    // The stream always carries debug, whatever the console is set to: turning it on
    // for an hour must not mean redeploying the container at a different level.
    const debugStream = createDebugStream({
      subscribers: () => store.debugSubscribers(env.discordGuildId, Date.now()).map((s) => s.userId),
      deliver: async (userId, message) => void (await (await client.users.fetch(userId)).send(message)),
      // Straight to the console: reporting a failed delivery through the stream that
      // failed would be a loop.
      onError: (userId, reason) => console.error(`could not send the log to ${userId}: ${reason}`),
    });
    log = tee(log, debugStream.logger);

    const prompt = loadPrompt(config.llm.promptPath);
    const provider =
      env.openrouterApiKey === null
        ? null
        : rateLimited(
            openRouterProvider({
              apiKey: env.openrouterApiKey,
              model: config.llm.model,
              timeoutMs: config.llm.requestTimeoutMs,
            }),
            { minIntervalMs: config.llm.minRequestIntervalMs },
          );
    const biggestHelmetId = config.helmets.reduce((a, b) => (b.rank > a.rank ? b : a)).id;
    try {
      // Nothing is provisioned, renamed or deleted while role management is off:
      // the guild is in a state the bot was told not to touch.
      const ops = canManageRoles ? reconcile(config.helmets, store.helmetRoles(env.discordGuildId), roles) : [];

      if (!canManageRoles) {
        log.warn("conversation only: the Pakled will talk, but no helmet will move");
      } else if (ops.length === 0) {
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

      const extra: string[] = canManageRoles
        ? [
            ops.length === 0
              ? "Helmet Set: already in sync, nothing to do"
              : `Helmet Set: ${ops.length} ${dryRun ? "change(s) pending (dry run — nothing applied)" : "change(s) applied"}`,
            ...ops.map((op) => `  ${dryRun ? "would " : ""}${describeOp(op)}`),
          ]
        : ["Helmet Set: untouched — role management is disabled", "The Pakled will still talk when spoken to."];

      // Re-snapshot before doing anything else: provisioning shifts every role up
      // by one per role created, the bot's own included. The pre-flight snapshot is
      // stale from here on, and comparing fresh member positions against a stale bot
      // position would wrongly exclude Eligible Members on a first provisioning run.
      // Only worth re-reading when something was actually changed.
      const after = canManageRoles
        ? checkReadiness(await snapshotGuild(guild, await listRoles(guild), config), config.helmets)
        : before;

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

        return async (state: string, facts: string, verified?: { assignments: { helmetId: string; memberId: string }[]; multihatMemberId?: string; pakledWentWithout?: boolean }): Promise<void> => {
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
                  verified ? verified.assignments.find((a) => a.helmetId === biggestHelmetId)?.memberId ?? null : store.currentHolderOf(env.discordGuildId, biggestHelmetId) ?? null,
                  verified ? verified.multihatMemberId ?? null : store.currentMultihat(env.discordGuildId) ?? null,
                  null,
                  verified?.pakledWentWithout ?? false,
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

      if (command !== "start") return after.ok ? 0 : 1;

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
        canManageRoles: after.ok,
      });
      return 0;
    } finally {
      // Whatever the last thing to happen was, whoever was watching should see it.
      debugStream.stop();
      await debugStream.flush();
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
