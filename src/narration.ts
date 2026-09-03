import type { Random } from "./ceremony.ts";

/**
 * Pacing for the Ceremony's messages.
 *
 * A Ceremony that dumps six messages in two seconds reads as a bot; spread across
 * a quarter of an hour it reads as an event, and the role changes land while the
 * Pakled is still talking about them.
 */

export type Beat = "epiphany" | "summon" | "barrel" | "redistribution" | "aftermath";

/** The order beats are performed in, and which of them mutate roles. */
export const BEATS: readonly Beat[] = ["epiphany", "summon", "barrel", "redistribution", "aftermath"];

/**
 * Gaps between beats, filling the configured span. Randomised so successive
 * Ceremonies do not feel metronomic, and never so long that the guild sits
 * half-helmeted for an age.
 */
export const beatDelays = (beats: number, minMs: number, maxMs: number, random: Random): number[] => {
  if (beats <= 1) return [];
  const gaps = beats - 1;
  const total = Math.floor(minMs) + (maxMs > minMs ? random.int(Math.floor(maxMs - minMs) + 1) : 0);
  const average = Math.floor(total / gaps);

  // Each gap wobbles around the average, and the last absorbs the rounding so the
  // whole Ceremony still fits the span it was given.
  const delays: number[] = [];
  let used = 0;
  for (let i = 0; i < gaps - 1; i++) {
    const jitter = average === 0 ? 0 : random.int(average) - Math.floor(average / 2);
    // Clamped against what is left, or several long gaps in a row could overrun the
    // span the operator configured.
    const delay = Math.min(Math.max(0, average + jitter), Math.max(0, total - used));
    delays.push(delay);
    used += delay;
  }
  delays.push(Math.max(0, total - used));
  return delays;
};

/** Static wording for when the model is unavailable. The Ceremony still happens. */
export const FALLBACK_BEATS: Record<Beat, string> = {
  epiphany: "This helmet is not the Biggest Helmet. I have discovered a problem.",
  summon: "Everyone give back the helmets. This is not a request. I am the leader.",
  barrel: "All helmets go in the Great Helmet Barrel. This is a very smart barrel.",
  redistribution: "The helmets are mixed. Now nobody knows which helmet is which.",
  aftermath: "I have a helmet. I do not think it is my helmet. I will think about it.",
};
