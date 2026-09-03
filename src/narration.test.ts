import { describe, expect, it } from "vitest";
import { seededRandom } from "./ceremony.ts";
import { BEATS, beatDelays, FALLBACK_BEATS } from "./narration.ts";

const MIN = 5 * 60_000;
const MAX = 15 * 60_000;

describe("beatDelays", () => {
  it("produces one gap fewer than there are beats", () => {
    expect(beatDelays(5, MIN, MAX, seededRandom(1))).toHaveLength(4);
  });

  it("produces no gaps for a single beat", () => {
    expect(beatDelays(1, MIN, MAX, seededRandom(1))).toEqual([]);
    expect(beatDelays(0, MIN, MAX, seededRandom(1))).toEqual([]);
  });

  it("fits the whole ceremony inside the configured span", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const total = beatDelays(5, MIN, MAX, seededRandom(seed)).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(MIN);
      expect(total).toBeLessThanOrEqual(MAX);
    }
  });

  it("never produces a negative gap", () => {
    for (let seed = 1; seed <= 100; seed++) {
      expect(beatDelays(6, MIN, MAX, seededRandom(seed)).every((d) => d >= 0)).toBe(true);
    }
  });

  it("does not pace every ceremony identically", () => {
    const shapes = new Set(
      Array.from({ length: 30 }, (_, i) => beatDelays(5, MIN, MAX, seededRandom(i)).join(",")),
    );
    expect(shapes.size).toBeGreaterThan(5);
  });

  it("copes with a zero-width span", () => {
    const delays = beatDelays(5, MIN, MIN, seededRandom(1));
    expect(delays.reduce((a, b) => a + b, 0)).toBe(MIN);
  });

  it("copes with no span at all", () => {
    expect(beatDelays(5, 0, 0, seededRandom(1))).toEqual([0, 0, 0, 0]);
  });

  it("is reproducible from a seed", () => {
    expect(beatDelays(5, MIN, MAX, seededRandom(3))).toEqual(beatDelays(5, MIN, MAX, seededRandom(3)));
  });
});

describe("fallback beats", () => {
  it("covers every beat, so a provider outage cannot leave one silent", () => {
    for (const beat of BEATS) expect(FALLBACK_BEATS[beat].length).toBeGreaterThan(0);
  });

  it("stays in character and never explains itself", () => {
    expect(FALLBACK_BEATS.aftermath).toMatch(/do not think it is my helmet/i);
  });
});
