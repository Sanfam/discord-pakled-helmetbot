import { describe, expect, it } from "vitest";
import { holdersLines, lastCeremonyLine, nextCeremonyLine, statusReport, type StatusView } from "./status.ts";

const NOW = 1_000_000_000_000;
const view = (over: Partial<StatusView> = {}): StatusView => ({
  schedule: { nextCeremonyAt: NOW + 3_600_000 * 50, paused: false, consecutiveFailures: 0 },
  maxConsecutiveFailures: 3,
  ceremoniesEnabled: true,
  lastCeremony: undefined,
  holders: [],
  llmModel: "some/model",
  now: NOW,
  ...over,
});

describe("nextCeremonyLine", () => {
  it("reports a scheduled ceremony in days when it is days away", () => {
    expect(nextCeremonyLine(view())).toMatch(/next helmet ceremony is in \d+ days/);
  });

  it("reports it in hours when it is closer", () => {
    const soon = view({ schedule: { nextCeremonyAt: NOW + 3_600_000 * 20, paused: false, consecutiveFailures: 0 } });
    expect(nextCeremonyLine(soon)).toMatch(/in 20 hours/);
  });

  it("reports it in minutes when it is very close", () => {
    const soon = view({ schedule: { nextCeremonyAt: NOW + 600_000, paused: false, consecutiveFailures: 0 } });
    expect(nextCeremonyLine(soon)).toMatch(/in 10 minutes/);
  });

  it("says so when paused", () => {
    expect(nextCeremonyLine(view({ schedule: { nextCeremonyAt: NOW, paused: true, consecutiveFailures: 0 } }))).toMatch(
      /stopped/i,
    );
  });

  it("says so when the circuit breaker has tripped, and that someone must act", () => {
    const broken = view({ schedule: { nextCeremonyAt: null, paused: false, consecutiveFailures: 3 } });
    expect(nextCeremonyLine(broken)).toMatch(/resume/i);
  });

  it("says so when ceremonies are switched off in config", () => {
    expect(nextCeremonyLine(view({ ceremoniesEnabled: false }))).toMatch(/switched off/i);
  });

  it("copes with nothing scheduled yet", () => {
    expect(nextCeremonyLine(view({ schedule: { nextCeremonyAt: null, paused: false, consecutiveFailures: 0 } }))).toMatch(
      /no plan yet/i,
    );
  });

  it("never says 'in 0 minutes'", () => {
    const almost = view({ schedule: { nextCeremonyAt: NOW + 1500, paused: false, consecutiveFailures: 0 } });
    expect(nextCeremonyLine(almost)).toMatch(/in 1 minute\b/);
  });

  it("stays in minutes below the hour", () => {
    const soon = view({ schedule: { nextCeremonyAt: NOW + 58 * 60_000, paused: false, consecutiveFailures: 0 } });
    expect(nextCeremonyLine(soon)).toMatch(/in 58 minutes/);
  });

  it("copes with an overdue ceremony", () => {
    expect(
      nextCeremonyLine(view({ schedule: { nextCeremonyAt: NOW - 10_000, paused: false, consecutiveFailures: 0 } })),
    ).toMatch(/any moment/i);
  });
});

describe("holdersLines", () => {
  it("says so when nobody holds anything", () => {
    expect(holdersLines(view())).toEqual(["Nobody has a helmet. This is wrong."]);
  });

  it("lists holders biggest first", () => {
    const lines = holdersLines(
      view({
        holders: [
          { helmetName: "A Tiny Helmet", rank: 1, memberLabel: "Ann" },
          { helmetName: "The Biggest Helmet", rank: 10, memberLabel: "Bob" },
        ],
      }),
    );
    expect(lines[0]).toContain("The Biggest Helmet");
    expect(lines.at(-1)).toContain("A Tiny Helmet");
  });

  it("copes with a helmet whose holder has left", () => {
    expect(holdersLines(view({ holders: [{ helmetName: "The Biggest Helmet", rank: 10, memberLabel: null }] }))).toEqual([
      "The Biggest Helmet — nobody",
    ]);
  });
});

describe("lastCeremonyLine", () => {
  const ceremony = (over: Record<string, unknown> = {}) =>
    ({ id: "c", guildId: "g", startedAt: "", completedAt: "2026-01-01", status: "COMPLETE", dryRun: false, ...over }) as never;

  it("copes with never having run one", () => {
    expect(lastCeremonyLine(view())).toMatch(/not been a ceremony yet/i);
  });

  it("admits a failure without explaining it", () => {
    expect(lastCeremonyLine(view({ lastCeremony: ceremony({ status: "FAILED" }) }))).toMatch(/went wrong/i);
  });

  it("distinguishes a dry run", () => {
    expect(lastCeremonyLine(view({ lastCeremony: ceremony({ dryRun: true }) }))).toMatch(/pretend/i);
  });

  it("does not claim an unfinished ceremony worked", () => {
    // Status is read most often precisely when one is slow or stuck.
    expect(lastCeremonyLine(view({ lastCeremony: ceremony({ completedAt: null, status: "BARREL" }) }))).toMatch(
      /happening now/i,
    );
  });

  it("stays suspicious after a successful one", () => {
    expect(lastCeremonyLine(view({ lastCeremony: ceremony() }))).toMatch(/do not think this is my helmet/i);
  });
});

describe("statusReport", () => {
  it("reads as the character rather than a dashboard", () => {
    const report = statusReport(view({ holders: [{ helmetName: "The Biggest Helmet", rank: 10, memberLabel: "Bob" }] }));
    expect(report).toContain("The Biggest Helmet — Bob");
  });

  it("says it is thinking for itself when no model is configured", () => {
    expect(statusReport(view({ llmModel: null }))).toMatch(/my own head/i);
  });

  it("never says the name of the model it is thinking with", () => {
    // A model id is a fact about the deployment, and there is no way to say
    // "deepseek/deepseek-v4-flash" that sounds like a Pakled.
    const report = statusReport(view({ llmModel: "some/model" }));
    expect(report).not.toContain("some/model");
    expect(report).not.toMatch(/my own head/i);
  });
});
