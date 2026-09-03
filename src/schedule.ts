import type { Random } from "./ceremony.ts";

/**
 * When the next Ceremony happens. Pure over an injected random source and an
 * explicit clock so the whole of it is testable without waiting days.
 *
 * The timestamp is persisted by the caller: a bot that rescheduled on every start
 * would fire a Ceremony every time it was redeployed.
 */

export type Timing = {
  minIntervalHours: number;
  maxIntervalHours: number;
  retryMinMinutes: number;
  retryMaxMinutes: number;
  maxConsecutiveFailures: number;
};

export type Schedule = {
  /** Epoch milliseconds, or null when nothing is scheduled. */
  nextCeremonyAt: number | null;
  paused: boolean;
  consecutiveFailures: number;
};

const HOUR = 3_600_000;
const MINUTE = 60_000;

const between = (minMs: number, maxMs: number, random: Random): number =>
  minMs + (maxMs > minMs ? random.int(maxMs - minMs + 1) : 0);

/** Deliberately not a cron: Ceremonies should be unpredictable. */
export const nextInterval = (minHours: number, maxHours: number, random: Random): number =>
  between(minHours * HOUR, maxHours * HOUR, random);

export const circuitBroken = (schedule: Schedule, maxConsecutiveFailures: number): boolean =>
  schedule.consecutiveFailures >= maxConsecutiveFailures;

export const afterSuccess = (now: number, timing: Timing, random: Random, previous: Schedule): Schedule => ({
  nextCeremonyAt: now + nextInterval(timing.minIntervalHours, timing.maxIntervalHours, random),
  paused: previous.paused,
  consecutiveFailures: 0,
});

/**
 * A failure retries in minutes, not days — but only until the breaker trips, after
 * which nothing is scheduled and an operator has to intervene. Retrying a broken
 * thing forever is how a bot becomes a noise generator.
 */
export const afterFailure = (now: number, timing: Timing, random: Random, previous: Schedule): Schedule => {
  const consecutiveFailures = previous.consecutiveFailures + 1;
  const broken = consecutiveFailures >= timing.maxConsecutiveFailures;
  return {
    nextCeremonyAt: broken ? null : now + between(timing.retryMinMinutes * MINUTE, timing.retryMaxMinutes * MINUTE, random),
    paused: previous.paused,
    consecutiveFailures,
  };
};

export const isDue = (schedule: Schedule, now: number, timing: Timing): boolean =>
  schedule.nextCeremonyAt !== null &&
  now >= schedule.nextCeremonyAt &&
  !schedule.paused &&
  !circuitBroken(schedule, timing.maxConsecutiveFailures);
