import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "./store.ts";
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

  it("keeps ceremonies separate by guild", () => {
    store.beginCeremony("g1", true);
    store.beginCeremony("g2", true);
    expect(store.ceremonies("g1")).toHaveLength(1);
    expect(store.ceremonies("g2")).toHaveLength(1);
  });
});
