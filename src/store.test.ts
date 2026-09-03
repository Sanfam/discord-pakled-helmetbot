import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CeremonyInFlightError, openStore, type Store } from "./store.ts";
import { PLANNING_STATES } from "./ceremony.ts";

describe("store", () => {
  let store: Store;
  beforeEach(() => void (store = openStore(":memory:")));
  afterEach(() => store.close());

  it("starts with nothing provisioned", () => {
    expect(store.helmetRoles("g1")).toEqual([]);
  });

  it("round-trips a provisioned helmet role", () => {
    store.recordHelmetRole("g1", "biggest", "r9");
    expect(store.helmetRoles("g1")).toEqual([{ helmetId: "biggest", roleId: "r9" }]);
  });

  it("keeps guilds separate", () => {
    store.recordHelmetRole("g1", "biggest", "r9");
    store.recordHelmetRole("g2", "biggest", "r7");
    expect(store.helmetRoles("g1")).toEqual([{ helmetId: "biggest", roleId: "r9" }]);
    expect(store.helmetRoles("g2")).toEqual([{ helmetId: "biggest", roleId: "r7" }]);
  });

  it("replaces the role id when a helmet is re-provisioned", () => {
    store.recordHelmetRole("g1", "biggest", "old");
    store.recordHelmetRole("g1", "biggest", "new");
    expect(store.helmetRoles("g1")).toEqual([{ helmetId: "biggest", roleId: "new" }]);
  });

  it("forgets a record without touching other guilds", () => {
    store.recordHelmetRole("g1", "biggest", "r9");
    store.recordHelmetRole("g2", "biggest", "r7");
    store.forgetHelmetRole("g1", "biggest");
    expect(store.helmetRoles("g1")).toEqual([]);
    expect(store.helmetRoles("g2")).toHaveLength(1);
  });
});

describe("ceremony records", () => {
  let store: Store;
  beforeEach(() => void (store = openStore(":memory:")));
  afterEach(() => store.close());

  it("records a dry run as distinguishable from a real ceremony", () => {
    const dry = store.beginCeremony("g1", true);
    store.completeCeremony(dry, "COMPLETE");
    const real = store.beginCeremony("g1", false);
    expect(store.ceremony(dry)?.dryRun).toBe(true);
    expect(store.ceremony(real)?.dryRun).toBe(false);
  });

  it("records the states a ceremony passed through, in order", () => {
    const id = store.beginCeremony("g1", true);
    for (const state of PLANNING_STATES) store.recordTransition(id, state);
    expect(store.ceremonyTransitions(id)).toEqual([...PLANNING_STATES]);
  });

  it("keeps status in step with the last transition recorded", () => {
    const id = store.beginCeremony("g1", true);
    store.recordTransition(id, "SUMMON");
    expect(store.ceremony(id)?.status).toBe("SUMMON");
  });

  it("records planned assignments", () => {
    const id = store.beginCeremony("g1", true);
    store.recordAssignments(id, [
      { helmetId: "biggest", memberId: "u1" },
      { helmetId: "tiny", memberId: "u2" },
    ]);
    expect(store.ceremonyAssignments(id)).toEqual([
      { helmetId: "biggest", memberId: "u1" },
      { helmetId: "tiny", memberId: "u2" },
    ]);
  });

  it("marks a ceremony complete", () => {
    const id = store.beginCeremony("g1", true);
    expect(store.ceremony(id)?.status).toBe("IDLE");
    store.completeCeremony(id, "COMPLETE");
    const done = store.ceremony(id);
    expect(done?.status).toBe("COMPLETE");
    expect(done?.completedAt).not.toBeNull();
  });

  it("refuses a second ceremony while one is in flight", () => {
    store.beginCeremony("g1", false);
    expect(() => store.beginCeremony("g1", false)).toThrow(CeremonyInFlightError);
  });

  it("allows a new ceremony once the previous one finished", () => {
    const first = store.beginCeremony("g1", false);
    store.completeCeremony(first, "COMPLETE");
    expect(() => store.beginCeremony("g1", false)).not.toThrow();
  });

  it("does not let one guild's in-flight ceremony block another", () => {
    store.beginCeremony("g1", false);
    expect(() => store.beginCeremony("g2", false)).not.toThrow();
  });

  it("records when a member was last seen, timestamps only", () => {
    store.recordMemberActivity("g1", "u1", 1000);
    expect(store.memberActivity("g1")).toEqual(new Map([["u1", 1000]]));
  });

  it("keeps the most recent sighting, never an older one", () => {
    // Messages can arrive out of order; the newest must win.
    store.recordMemberActivity("g1", "u1", 5000);
    store.recordMemberActivity("g1", "u1", 1000);
    expect(store.memberActivity("g1").get("u1")).toBe(5000);
  });

  it("keeps member activity separate by guild", () => {
    store.recordMemberActivity("g1", "u1", 1000);
    store.recordMemberActivity("g2", "u1", 2000);
    expect(store.memberActivity("g1").get("u1")).toBe(1000);
    expect(store.memberActivity("g2").get("u1")).toBe(2000);
  });

  it("has no member activity on a fresh install", () => {
    expect(store.memberActivity("g1").size).toBe(0);
  });

  it("has no schedule before one is saved", () => {
    expect(store.schedule("g1")).toEqual({ nextCeremonyAt: null, paused: false, consecutiveFailures: 0 });
  });

  it("persists a schedule so a restart does not trigger a ceremony", () => {
    store.saveSchedule("g1", { nextCeremonyAt: 1234, paused: false, consecutiveFailures: 1 });
    expect(store.schedule("g1")).toEqual({ nextCeremonyAt: 1234, paused: false, consecutiveFailures: 1 });
  });

  it("persists the paused flag", () => {
    store.saveSchedule("g1", { nextCeremonyAt: null, paused: true, consecutiveFailures: 0 });
    expect(store.schedule("g1").paused).toBe(true);
  });

  it("keeps schedules separate by guild", () => {
    store.saveSchedule("g1", { nextCeremonyAt: 1, paused: true, consecutiveFailures: 0 });
    store.saveSchedule("g2", { nextCeremonyAt: 2, paused: false, consecutiveFailures: 0 });
    expect(store.schedule("g1").paused).toBe(true);
    expect(store.schedule("g2").nextCeremonyAt).toBe(2);
  });

  it("keeps ceremonies separate by guild", () => {
    store.beginCeremony("g1", true);
    store.beginCeremony("g2", true);
    expect(store.ceremonies("g1")).toHaveLength(1);
    expect(store.ceremonies("g2")).toHaveLength(1);
  });
});
