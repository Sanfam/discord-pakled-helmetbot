import { describe, expect, it } from "vitest";
import { afterFailure, afterSuccess, circuitBroken, isDue, nextInterval, type Schedule } from "./schedule.ts";
import { seededRandom } from "./ceremony.ts";

const timing = {
  minIntervalHours: 72,
  maxIntervalHours: 336,
  retryMinMinutes: 15,
  retryMaxMinutes: 60,
  maxConsecutiveFailures: 3,
};
const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;
const idle: Schedule = { nextCeremonyAt: null, paused: false, consecutiveFailures: 0 };

describe("nextInterval", () => {
  it("stays within the configured bounds", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const ms = nextInterval(72, 336, seededRandom(seed));
      expect(ms).toBeGreaterThanOrEqual(72 * HOUR);
      expect(ms).toBeLessThanOrEqual(336 * HOUR);
    }
  });

  it("is not a fixed schedule", () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => nextInterval(72, 336, seededRandom(i))));
    expect(seen.size).toBeGreaterThan(10);
  });

  it("copes with a zero-width window", () => {
    expect(nextInterval(72, 72, seededRandom(1))).toBe(72 * HOUR);
  });
});

describe("afterSuccess", () => {
  it("schedules the next ceremony days away and clears failures", () => {
    const next = afterSuccess(NOW, timing, seededRandom(4), { ...idle, consecutiveFailures: 2 });
    expect(next.nextCeremonyAt! - NOW).toBeGreaterThanOrEqual(72 * HOUR);
    expect(next.consecutiveFailures).toBe(0);
  });

  it("leaves a paused bot paused", () => {
    expect(afterSuccess(NOW, timing, seededRandom(1), { ...idle, paused: true }).paused).toBe(true);
  });
});

describe("afterFailure", () => {
  it("retries within the short window rather than a full interval", () => {
    const next = afterFailure(NOW, timing, seededRandom(2), idle);
    const delay = next.nextCeremonyAt! - NOW;
    expect(delay).toBeGreaterThanOrEqual(15 * 60_000);
    expect(delay).toBeLessThanOrEqual(60 * 60_000);
  });

  it("counts consecutive failures", () => {
    let s = idle;
    for (let i = 1; i <= 3; i++) s = afterFailure(NOW, timing, seededRandom(i), s);
    expect(s.consecutiveFailures).toBe(3);
  });

  it("stops scheduling once the circuit breaker trips", () => {
    let s = idle;
    for (let i = 1; i <= 3; i++) s = afterFailure(NOW, timing, seededRandom(i), s);
    expect(circuitBroken(s, timing.maxConsecutiveFailures)).toBe(true);
    expect(s.nextCeremonyAt).toBeNull();
  });
});

describe("isDue", () => {
  it("is not due before its time", () => {
    expect(isDue({ ...idle, nextCeremonyAt: NOW + 1000 }, NOW, timing)).toBe(false);
  });

  it("is due at its time", () => {
    expect(isDue({ ...idle, nextCeremonyAt: NOW }, NOW, timing)).toBe(true);
  });

  it("is never due while paused", () => {
    expect(isDue({ ...idle, nextCeremonyAt: NOW - HOUR, paused: true }, NOW, timing)).toBe(false);
  });

  it("is never due once the circuit breaker has tripped", () => {
    const broken = { ...idle, nextCeremonyAt: NOW - HOUR, consecutiveFailures: 3 };
    expect(isDue(broken, NOW, timing)).toBe(false);
  });

  it("is not due when nothing has been scheduled", () => {
    expect(isDue(idle, NOW, timing)).toBe(false);
  });

  it("does not fire immediately for a schedule that survived a restart", () => {
    // The whole point of persisting the timestamp: a redeploy must not trigger a ceremony.
    const persisted = { ...idle, nextCeremonyAt: NOW + 40 * HOUR };
    expect(isDue(persisted, NOW, timing)).toBe(false);
    expect(isDue(persisted, NOW + 41 * HOUR, timing)).toBe(true);
  });
});
