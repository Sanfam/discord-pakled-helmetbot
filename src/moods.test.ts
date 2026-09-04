import { describe, expect, it } from "vitest";
import { seededRandom } from "./ceremony.ts";
import { chattiness, COVET_SEEDS, HELMETLESS_SEEDS, MULTIHAT_SEEDS, NO_MOOD, seedFor } from "./moods.ts";

const HOUR = 3_600_000;

describe("chattiness", () => {
  it("leaves an unmoved Pakled at its normal pace", () => {
    expect(chattiness(NO_MOOD, 0)).toBe(1);
    expect(chattiness(NO_MOOD, 40 * HOUR)).toBe(1);
  });

  it("speaks up twice as often right after losing out", () => {
    expect(chattiness({ ...NO_MOOD, helmetless: true }, 0)).toBe(2);
  });

  it("is loudest when it wants one particular helmet", () => {
    expect(chattiness({ ...NO_MOOD, coveting: true }, 0)).toBe(4);
  });

  it("fades back to normal within a day", () => {
    const mood = { ...NO_MOOD, helmetless: true };
    expect(chattiness(mood, 1 * HOUR)).toBe(2);
    expect(chattiness(mood, 5 * HOUR)).toBeCloseTo(1.6);
    expect(chattiness(mood, 12 * HOUR)).toBeCloseTo(1.2);
    expect(chattiness(mood, 25 * HOUR)).toBe(1);
  });

  it("takes the loudest mood rather than multiplying them together", () => {
    // Being helmetless and coveting at once is the character at its most
    // interesting, and 8x is the character at its most unbearable.
    expect(chattiness({ helmetless: true, coveting: true, multihat: true }, 0)).toBe(4);
  });

  it("treats a mood with no known ceremony time as fresh rather than ignoring it", () => {
    expect(chattiness({ ...NO_MOOD, helmetless: true }, null)).toBe(2);
  });

  it("never slows the bot down", () => {
    for (const hours of [0, 1, 3, 9, 23, 24, 100]) {
      expect(chattiness({ ...NO_MOOD, multihat: true }, hours * HOUR)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("seedFor", () => {
  it("says nothing extra when nothing has happened", () => {
    expect(seedFor(NO_MOOD, seededRandom(1))).toBeNull();
  });

  it("prefers the plan over the worry when it has both", () => {
    const seed = seedFor({ helmetless: true, coveting: true, multihat: false }, seededRandom(3));
    expect(COVET_SEEDS as readonly string[]).toContain(seed);
  });

  it("draws from the matching pool", () => {
    expect(HELMETLESS_SEEDS as readonly string[]).toContain(seedFor({ ...NO_MOOD, helmetless: true }, seededRandom(5)));
    expect(MULTIHAT_SEEDS as readonly string[]).toContain(seedFor({ ...NO_MOOD, multihat: true }, seededRandom(5)));
  });

  it("varies between utterances, so days of one mood are not one sentence", () => {
    const drawn = new Set(
      Array.from({ length: 40 }, (_, i) => seedFor({ ...NO_MOOD, helmetless: true }, seededRandom(i))),
    );
    expect(drawn.size).toBeGreaterThan(3);
  });
});
