import type { Random } from "./ceremony.ts";

/**
 * Whether the Pakled says anything unprompted, and where.
 *
 * The gates run cheapest first — activity floor, then cooldown, then chance — so
 * that the expensive, paid step is reached only when the cheap ones have already
 * agreed. Silence is the normal outcome and is in character.
 */

export type ActivityEvent = { at: number; authorId: string };

export type ActivityFloor = {
  windowMinutes: number;
  minMessages: number;
  /** More than one, or the bot answers someone talking to themselves. */
  minDistinctAuthors: number;
};

export type ChannelActivity = {
  channelId: string;
  lastMessageAt: number;
  lastBotMessageAt: number | null;
};

const MINUTE = 60_000;

/**
 * Enough recent conversation, from enough different people, to be worth joining.
 * Talking into an empty room is not a contribution.
 */
export const meetsActivityFloor = (events: ActivityEvent[], now: number, floor: ActivityFloor): boolean => {
  const recent = events.filter((e) => now - e.at <= floor.windowMinutes * MINUTE);
  if (recent.length < floor.minMessages) return false;
  return new Set(recent.map((e) => e.authorId)).size >= floor.minDistinctAuthors;
};

/**
 * One Active Channel at a time, weighted toward recent conversation and away from
 * wherever the bot last spoke, so it wanders instead of settling.
 */
export const selectActiveChannel = (
  candidates: ChannelActivity[],
  now: number,
  random: Random,
): string | null => {
  if (candidates.length === 0) return null;

  const weights = candidates.map((c) => {
    // Recency of conversation, decaying over hours rather than falling off a cliff.
    const idleHours = Math.max(0, now - c.lastMessageAt) / 3_600_000;
    const activity = 1 / (1 + idleHours);
    // Having just spoken here is a reason to go elsewhere, not a prohibition.
    const sinceBotHours = c.lastBotMessageAt === null ? Infinity : Math.max(0, now - c.lastBotMessageAt) / 3_600_000;
    const penalty = sinceBotHours === Infinity ? 1 : Math.min(1, sinceBotHours / 6);
    return Math.max(0.001, activity * (0.1 + 0.9 * penalty));
  });

  const total = weights.reduce((a, b) => a + b, 0);
  // Resolution of 10,000 is ample for a handful of channels and keeps this integer.
  let ticket = random.int(10_000) / 10_000 * total;
  for (const [i, weight] of weights.entries()) {
    ticket -= weight;
    if (ticket < 0) return candidates[i]!.channelId;
  }
  return candidates.at(-1)!.channelId;
};

/** Never a fixed cadence: "the bot posts every 30 minutes" is not a character. */
export const nextPassiveDelay = (minMinutes: number, maxMinutes: number, random: Random): number => {
  // Floored regardless of what configuration allowed: a fractional bound reaches
  // crypto.randomInt, which throws, and this runs inside a self-rescheduling chain.
  const min = Math.floor(minMinutes * MINUTE);
  const max = Math.floor(maxMinutes * MINUTE);
  return min + (max > min ? random.int(max - min + 1) : 0);
};

/**
 * Why the Pakled did not speak, in enough detail to act on. "The gates declined" is
 * three different situations — nobody is talking, it only just spoke here, or the
 * dice said no — and they call for three different responses from whoever is
 * reading the logs.
 */
export type PassiveDecision =
  | { speak: true }
  | { speak: false; gate: "activity-floor"; recentMessages: number; distinctAuthors: number; needMessages: number; needAuthors: number }
  | { speak: false; gate: "channel-cooldown"; quietForMinutes: number; needMinutes: number }
  | { speak: false; gate: "chance"; probability: number };

export const shouldConsiderSpeaking = (
  args: {
    events: ActivityEvent[];
    now: number;
    floor: ActivityFloor;
    lastBotMessageAt: number | null;
    channelCooldownMinutes: number;
    probability: number;
  },
  random: Random,
): PassiveDecision => {
  // Cheapest first: no LLM call is made, or even contemplated, below the floor.
  const recent = args.events.filter((e) => args.now - e.at <= args.floor.windowMinutes * MINUTE);
  const distinctAuthors = new Set(recent.map((e) => e.authorId)).size;
  if (recent.length < args.floor.minMessages || distinctAuthors < args.floor.minDistinctAuthors) {
    return {
      speak: false,
      gate: "activity-floor",
      recentMessages: recent.length,
      distinctAuthors,
      needMessages: args.floor.minMessages,
      needAuthors: args.floor.minDistinctAuthors,
    };
  }

  if (args.lastBotMessageAt !== null && args.now - args.lastBotMessageAt < args.channelCooldownMinutes * MINUTE) {
    return {
      speak: false,
      gate: "channel-cooldown",
      quietForMinutes: Math.round((args.now - args.lastBotMessageAt) / MINUTE),
      needMinutes: args.channelCooldownMinutes,
    };
  }

  if (random.int(10_000) / 10_000 >= args.probability) {
    return { speak: false, gate: "chance", probability: args.probability };
  }
  return { speak: true };
};
