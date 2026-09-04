import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

describe("recovery", () => {
  let store: Store;
  beforeEach(() => void (store = openStore(":memory:")));
  afterEach(() => store.close());

  it("a stranded ceremony blocks every later one until it is abandoned", () => {
    const stranded = store.beginCeremony("g1", false);
    expect(() => store.beginCeremony("g1", false)).toThrow(CeremonyInFlightError);

    store.abandonCeremony(stranded, "abandoned: the bot stopped while it was running");
    expect(() => store.beginCeremony("g1", false)).not.toThrow();
  });

  it("an abandoned ceremony is recorded as failed, not quietly completed", () => {
    const id = store.beginCeremony("g1", false);
    store.abandonCeremony(id, "abandoned");
    const record = store.ceremony(id);
    expect(record?.status).toBe("FAILED");
    expect(record?.completedAt).not.toBeNull();
  });
});

describe("schema upgrades", () => {
  it("adds a column to a database created before it existed", () => {
    // CREATE TABLE IF NOT EXISTS is silent on an existing table, so an in-memory
    // test can never catch a missing column. This one builds the old shape first.
    const file = join(mkdtempSync(join(tmpdir(), "pakled-")), "bot.sqlite");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE ceremonies (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, started_at TEXT NOT NULL,
      completed_at TEXT, status TEXT NOT NULL, dry_run INTEGER NOT NULL
    ) STRICT;`);
    old.close();

    const store = openStore(file);
    const id = store.beginCeremony("g1", false);
    expect(() => store.abandonCeremony(id, "abandoned")).not.toThrow();
    expect(store.ceremony(id)?.status).toBe("FAILED");
    store.close();
  });
});

describe("the Multihat", () => {
  let store: Store;
  beforeEach(() => void (store = openStore(":memory:")));
  afterEach(() => store.close());

  it("remembers who the last completed Ceremony blessed", () => {
    const id = store.beginCeremony("g1", false);
    store.recordMultihat(id, "u1");
    store.completeCeremony(id, "COMPLETE");
    expect(store.currentMultihat("g1")).toBe("u1");
  });

  it("remembers the helmet the Pakled fixed on, and that it went without", () => {
    const id = store.beginCeremony("g1", false);
    store.recordCovet(id, "sizeable");
    store.recordPakledWentWithout(id);
    store.completeCeremony(id, "COMPLETE");

    const outcome = store.lastOutcome("g1");
    expect(outcome?.covetedHelmetId).toBe("sizeable");
    expect(outcome?.pakledWentWithout).toBe(true);
    expect(outcome?.completedAt).toBeTypeOf("number");
  });

  it("lets a mood expire at the next Ceremony, like reverence does", () => {
    const first = store.beginCeremony("g1", false);
    store.recordCovet(first, "sizeable");
    store.recordPakledWentWithout(first);
    store.completeCeremony(first, "COMPLETE");

    const second = store.beginCeremony("g1", false);
    store.completeCeremony(second, "COMPLETE");

    const outcome = store.lastOutcome("g1");
    expect(outcome?.covetedHelmetId).toBeUndefined();
    expect(outcome?.pakledWentWithout).toBe(false);
  });

  it("reports no outcome at all before the first Ceremony", () => {
    expect(store.lastOutcome("g1")).toBeUndefined();
  });

  it("expires at the next Ceremony that has no Multihat", () => {
    // Reverence must not outlive the helmets that earned it.
    const first = store.beginCeremony("g1", false);
    store.recordMultihat(first, "u1");
    store.completeCeremony(first, "COMPLETE");

    const second = store.beginCeremony("g1", false);
    store.completeCeremony(second, "COMPLETE");
    expect(store.currentMultihat("g1")).toBeUndefined();
  });

  it("is not conferred by a dry run", () => {
    const id = store.beginCeremony("g1", true);
    store.recordMultihat(id, "u1");
    store.completeCeremony(id, "COMPLETE");
    expect(store.currentMultihat("g1")).toBeUndefined();
  });

  it("is not conferred by a failed Ceremony", () => {
    const id = store.beginCeremony("g1", false);
    store.recordMultihat(id, "u1");
    store.completeCeremony(id, "FAILED");
    expect(store.currentMultihat("g1")).toBeUndefined();
  });

  it("does not leak between guilds", () => {
    const id = store.beginCeremony("g1", false);
    store.recordMultihat(id, "u1");
    store.completeCeremony(id, "COMPLETE");
    expect(store.currentMultihat("g2")).toBeUndefined();
  });
});
