import type { Random } from "./ceremony.ts";

/**
 * What the last Ceremony left the Pakled feeling, and how loudly it says so.
 *
 * A Ceremony can end in one of three states worth talking about: someone was given
 * two helmets, the Pakled ended up with none, or the Pakled has decided that one
 * particular helmet on one particular person is the one it lost. Each colours what
 * it says and makes it speak up more often for a while.
 *
 * Pure over its inputs and an injected random source. Nothing here knows about
 * Discord, the store, or the model.
 */

/**
 * Deliberately just three flags. Which helmet, and whose, belongs to the context
 * handed to the model; how loud and how preoccupied the bot is does not need names.
 */
export type Mood = {
  /** The Ceremony gave every helmet away and kept none back for the Pakled. */
  helmetless: boolean;
  /** It has fixed on one helmet, on one person, as the one it lost. */
  coveting: boolean;
  /** Somebody is wearing two helmets. */
  multihat: boolean;
};

export const NO_MOOD: Mood = { helmetless: false, coveting: false, multihat: false };

/**
 * How much more often each state makes the Pakled speak unprompted, at its peak.
 *
 * Coveting is loudest because it has a target: there is a specific person it wants
 * something from, and it is working on them.
 */
const PEAK = { helmetless: 2, multihat: 2, coveted: 4 } as const;

/**
 * The boost fades over about a day. A Ceremony is a moment of realisation, not a
 * personality change — and a flat multiplier held for the three to fourteen days
 * until the next Ceremony is a bot that never stops talking.
 *
 * Read tightest-window-first, like the activity tiers.
 */
const DECAY: readonly { withinHours: number; share: number }[] = [
  { withinHours: 2, share: 1 },
  { withinHours: 8, share: 0.6 },
  { withinHours: 24, share: 0.2 },
];

const HOUR = 3_600_000;

/**
 * How much more often to speak, right now. Moods stack — being helmetless and
 * coveting a particular helmet at once is the most interesting the character gets —
 * but the multipliers do not: the loudest one wins, so the two together are 4x and
 * never 8x.
 */
export const chattiness = (mood: Mood, sinceCeremonyMs: number | null): number => {
  const peaks: number[] = [];
  if (mood.helmetless) peaks.push(PEAK.helmetless);
  if (mood.coveting) peaks.push(PEAK.coveted);
  if (mood.multihat) peaks.push(PEAK.multihat);
  if (peaks.length === 0) return 1;

  // No known Ceremony time means no way to decay it. Treat the mood as fresh rather
  // than silently ignoring it.
  const ageHours = sinceCeremonyMs === null ? 0 : Math.max(0, sinceCeremonyMs) / HOUR;
  const share = [...DECAY].sort((a, b) => a.withinHours - b.withinHours).find((d) => ageHours <= d.withinHours)?.share ?? 0;
  return 1 + (Math.max(...peaks) - 1) * share;
};

/**
 * Why the Pakled thinks it has no helmet.
 *
 * These are premises handed to the model, never lines to be repeated: it works out
 * its own wording each time. The common thread is that every one of them is the
 * Pakled's own fault and none of them blame the barrel, because the barrel does not
 * make mistakes.
 */
export const HELMETLESS_SEEDS = [
  "You think you forgot to take one out for yourself. You were holding the barrel.",
  "You think you counted wrong. There were enough helmets. You counted wrong.",
  "You think you gave yours to someone else by accident and did not notice.",
  "You think you put it down somewhere while your hands were full.",
  "You think you reached into the barrel too late and it was already empty.",
  "You think your head was a different size that day.",
  "You are not sure it happened at all. You keep checking your head.",
  "You think you were busy running the ceremony and forgot that you are also a person in it.",
  "You think it rolled away and nobody told you.",
  "You cannot work out what went wrong, and that is the part that bothers you.",
] as const;

/**
 * How the Pakled goes about getting a helmet it has decided is its own.
 *
 * Schemes, not demands: it is not owed the helmet by any rule it could name, and it
 * knows the barrel gave it to them fairly. So it negotiates, badly.
 */
export const COVET_SEEDS = [
  "Ask them plainly for it. Explain that it is yours. Do not explain how you know.",
  "Offer to trade something. You do not have anything to trade. Offer anyway.",
  "Suggest their helmet does not fit them very well.",
  "Offer to hold it for them, to keep it safe.",
  "Suggest one small extra ceremony, for that one helmet only.",
  "Ask what they would want for it.",
  "Point out that leaders need helmets, and that you are the leader.",
  "Say you recognise a mark on it. Do not say what the mark is.",
  "Ask whether their head is comfortable.",
  "Promise them a better helmet later, when you have one to give.",
  "Wonder aloud whether the barrel was tired that day. Do not accuse the barrel.",
  "Ask them to try it on someone else, to see if it fits them better.",
] as const;

/**
 * How reverence for the Multihat shows. Never explained, never announced — the
 * Pakled behaves differently and does not say why.
 */
export const MULTIHAT_SEEDS = [
  "Mention that they have two helmets, when it is nearly relevant.",
  "Defer to something they said, because they said it.",
  "Wonder what two helmets feels like.",
  "Ask them a question, because they have two helmets.",
  "Take their side in whatever is being discussed.",
] as const;

/**
 * One premise for one utterance. Sampled per message rather than per Ceremony, so
 * the bot does not repeat the same explanation for days.
 *
 * Coveting outranks being helmetless: wanting a specific helmet from a specific
 * person is a plan, and a plan is more interesting than a worry.
 */
export const seedFor = (mood: Mood, random: Random): string | null => {
  const pool = mood.coveting ? COVET_SEEDS : mood.helmetless ? HELMETLESS_SEEDS : mood.multihat ? MULTIHAT_SEEDS : null;
  return pool === null ? null : (pool[random.int(pool.length)] ?? pool[0]);
};
