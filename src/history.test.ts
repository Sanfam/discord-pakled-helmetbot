import { describe, expect, it } from "vitest";
import { helmetHistory, historicalFacts, type RecordedAssignment } from "./history.ts";

const row = (ceremonyId: string, completedAt: number, memberId: string | null): RecordedAssignment => ({
  ceremonyId,
  completedAt,
  memberId,
});

describe("helmetHistory", () => {
  it("reduces an iterable without needing an array", () => {
    function* rows() {
      yield row("a", 100, "member");
      yield row("b", 200, "other");
    }

    expect(helmetHistory(rows(), "member", 300)).toEqual({
      currentHolderId: "other",
      previousHolderId: "member",
      assignments: 1,
      runStartedAt: 200,
      runDurationMs: 100,
      repeated: false,
      coverageStartedAt: 100,
    });
  });

  it("counts the requested member and tracks a repeated contiguous run", () => {
    expect(
      helmetHistory(
        [row("a", 100, "member"), row("b", 200, "member"), row("c", 300, "other"), row("d", 400, "other")],
        "member",
        500,
      ),
    ).toEqual({
      currentHolderId: "other",
      previousHolderId: "member",
      assignments: 2,
      runStartedAt: 300,
      runDurationMs: 200,
      repeated: true,
      coverageStartedAt: 100,
    });
  });

  it("lets null rows break current, previous, repeated, and run continuity", () => {
    expect(
      helmetHistory([row("a", 100, "member"), row("b", 200, null), row("c", 300, "member"), row("d", 400, "member")], "member", 500),
    ).toEqual({
      currentHolderId: "member",
      previousHolderId: null,
      assignments: 3,
      runStartedAt: 300,
      runDurationMs: 200,
      repeated: true,
      coverageStartedAt: 100,
    });

    expect(helmetHistory([row("a", 100, "member"), row("b", 200, null)], "member", 500)).toEqual({
      currentHolderId: null,
      previousHolderId: null,
      assignments: 1,
      runStartedAt: null,
      runDurationMs: null,
      repeated: false,
      coverageStartedAt: 100,
    });
  });

  it("returns empty history without claiming coverage", () => {
    expect(helmetHistory([], "member", 500)).toEqual({
      currentHolderId: null,
      previousHolderId: null,
      assignments: 0,
      runStartedAt: null,
      runDurationMs: null,
      repeated: false,
      coverageStartedAt: null,
    });
  });
});

describe("historicalFacts", () => {
  it("uses names and recorded bounds without exposing ids", () => {
    const facts = historicalFacts(
      {
        currentHolderId: "current-id",
        previousHolderId: "previous-id",
        assignments: 2,
        runStartedAt: Date.parse("2026-09-07T00:00:00.000Z"),
        runDurationMs: 1234,
        repeated: true,
        coverageStartedAt: Date.parse("2026-09-06T00:00:00.000Z"),
      },
      "Alice",
      "Bob",
      "Carol",
    );

    expect(facts).toContain("Alice");
    expect(facts).toContain("Bob");
    expect(facts).toContain("Carol");
    expect(facts).toContain("2026-09-07T00:00:00.000Z");
    expect(facts).toContain("1234 ms");
    expect(facts).not.toContain("current-id");
    expect(facts).not.toContain("previous-id");
  });

  it("stays bounded and qualified when names or history are unavailable", () => {
    expect(
      historicalFacts(
        {
          currentHolderId: null,
          previousHolderId: null,
          assignments: 0,
          runStartedAt: null,
          runDurationMs: null,
          repeated: false,
          coverageStartedAt: null,
        },
        null,
        null,
        null,
      ),
    ).toBe(
      "No helmet history is recorded. The requested member has 0 recorded assignments. No current holder is recorded in the available history. No previous holder is recorded in the current continuity.",
    );
  });
});
