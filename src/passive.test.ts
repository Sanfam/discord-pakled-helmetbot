import { describe, expect, it } from "vitest";
import { seededRandom } from "./ceremony.ts";
import {
  meetsActivityFloor,
  nextPassiveDelay,
  selectActiveChannel,
  shouldConsiderSpeaking,
  type ActivityEvent,
  type ChannelActivity,
} from "./passive.ts";

const NOW = 1_000_000;
const MIN = 60_000;
const floor = { windowMinutes: 30, minMessages: 5, minDistinctAuthors: 2 };

const events = (count: number, authors: string[], agoMinutes = 1): ActivityEvent[] =>
  Array.from({ length: count }, (_, i) => ({
    at: NOW - agoMinutes * MIN,
    authorId: authors[i % authors.length]!,
  }));

describe("meetsActivityFloor", () => {
  it("passes when enough people have said enough recently", () => {
    expect(meetsActivityFloor(events(6, ["a", "b"]), NOW, floor)).toBe(true);
  });

  it("fails in a silent channel", () => {
    // A quiet server must produce no passive messages at all.
    expect(meetsActivityFloor([], NOW, floor)).toBe(false);
  });

  it("fails when one person is talking to themselves", () => {
    expect(meetsActivityFloor(events(20, ["a"]), NOW, floor)).toBe(false);
  });

  it("fails when there are too few messages", () => {
    expect(meetsActivityFloor(events(3, ["a", "b"]), NOW, floor)).toBe(false);
  });

  it("ignores conversation that has gone cold", () => {
    expect(meetsActivityFloor(events(20, ["a", "b"], 120), NOW, floor)).toBe(false);
  });
});

describe("selectActiveChannel", () => {
  const channel = (id: string, over: Partial<ChannelActivity> = {}): ChannelActivity => ({
    channelId: id,
    lastMessageAt: NOW - MIN,
    lastBotMessageAt: null,
    ...over,
  });

  it("returns nothing when there are no candidates", () => {
    expect(selectActiveChannel([], NOW, seededRandom(1))).toBeNull();
  });

  it("picks exactly one channel", () => {
    const picked = selectActiveChannel([channel("a"), channel("b")], NOW, seededRandom(1));
    expect(["a", "b"]).toContain(picked);
  });

  it("prefers the channel with more recent conversation", () => {
    const busy = channel("busy", { lastMessageAt: NOW - MIN });
    const cold = channel("cold", { lastMessageAt: NOW - 600 * MIN });
    const picks = Array.from({ length: 40 }, (_, i) => selectActiveChannel([busy, cold], NOW, seededRandom(i)));
    expect(picks.filter((p) => p === "busy").length).toBeGreaterThan(picks.filter((p) => p === "cold").length);
  });

  it("penalises a channel the bot has just spoken in, so it rotates", () => {
    const justSpoke = channel("recent", { lastBotMessageAt: NOW - MIN });
    const untouched = channel("fresh", { lastBotMessageAt: null });
    const picks = Array.from({ length: 40 }, (_, i) => selectActiveChannel([justSpoke, untouched], NOW, seededRandom(i)));
    expect(picks.filter((p) => p === "fresh").length).toBeGreaterThan(picks.filter((p) => p === "recent").length);
  });

  it("does not always pick the same channel", () => {
    const picks = new Set(
      Array.from({ length: 40 }, (_, i) => selectActiveChannel([channel("a"), channel("b")], NOW, seededRandom(i))),
    );
    expect(picks.size).toBe(2);
  });
});

describe("nextPassiveDelay", () => {
  it("stays within the configured bounds", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const ms = nextPassiveDelay(45, 180, seededRandom(seed));
      expect(ms).toBeGreaterThanOrEqual(45 * MIN);
      expect(ms).toBeLessThanOrEqual(180 * MIN);
    }
  });

  it("varies rather than being fixed", () => {
    const seen = new Set(Array.from({ length: 30 }, (_, i) => nextPassiveDelay(45, 180, seededRandom(i))));
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe("shouldConsiderSpeaking", () => {
  const gates = {
    events: events(6, ["a", "b"]),
    now: NOW,
    floor,
    lastBotMessageAt: null as number | null,
    channelCooldownMinutes: 90,
    probability: 1,
  };

  it("passes every gate when the channel is busy and the bot has been quiet", () => {
    expect(shouldConsiderSpeaking({ ...gates }, seededRandom(1))).toBe(true);
  });

  it("refuses below the activity floor without consulting chance", () => {
    expect(shouldConsiderSpeaking({ ...gates, events: [] }, seededRandom(1))).toBe(false);
  });

  it("refuses while the channel cooldown is running", () => {
    expect(shouldConsiderSpeaking({ ...gates, lastBotMessageAt: NOW - 10 * MIN }, seededRandom(1))).toBe(false);
  });

  it("allows again once the channel cooldown has passed", () => {
    expect(shouldConsiderSpeaking({ ...gates, lastBotMessageAt: NOW - 120 * MIN }, seededRandom(1))).toBe(true);
  });

  it("declines by chance even when everything else passes", () => {
    expect(shouldConsiderSpeaking({ ...gates, probability: 0 }, seededRandom(1))).toBe(false);
  });

  it("speaks sometimes and not others at even odds", () => {
    const outcomes = new Set(
      Array.from({ length: 40 }, (_, i) => shouldConsiderSpeaking({ ...gates, probability: 0.5 }, seededRandom(i))),
    );
    expect(outcomes).toEqual(new Set([true, false]));
  });
});
