import { describe, expect, it } from "vitest";
import {
  eligibleMembers,
  helmetRoleMap,
  memberLabels,
  planCeremony,
  seededRandom,
  summariseEligibility,
  type EligibilityRules,
  type Member,
} from "./ceremony.ts";
import type { Helmet } from "./config.ts";

const helmet = (id: string, rank: number): Helmet => ({ id, name: `Helmet ${id}`, rank, hoist: true });
const helmets = [helmet("tiny", 1), helmet("middling", 2), helmet("biggest", 3)];

const member = (id: string, over: Partial<Member> = {}): Member => ({
  id,
  displayName: id,
  username: id,
  isBot: false,
  roleIds: [],
  highestRolePosition: 1,
  ...over,
});

const PAKLED = "pakled";
const rules = (over: Partial<EligibilityRules> = {}): EligibilityRules => ({
  pakledId: PAKLED,
  excludedUserIds: [],
  excludedRoleIds: [],
  botHighestRolePosition: 10,
  ...over,
});

describe("eligibleMembers", () => {
  it("includes ordinary members", () => {
    expect(eligibleMembers([member("a"), member("b")], rules()).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("excludes other bots", () => {
    expect(eligibleMembers([member("a"), member("robot", { isBot: true })], rules()).map((m) => m.id)).toEqual(["a"]);
  });

  it("includes The Pakled even though it is a bot (ADR-0001)", () => {
    const members = [member(PAKLED, { isBot: true, highestRolePosition: 10 })];
    expect(eligibleMembers(members, rules()).map((m) => m.id)).toEqual([PAKLED]);
  });

  it("excludes configured user ids", () => {
    const found = eligibleMembers([member("a"), member("b")], rules({ excludedUserIds: ["b"] }));
    expect(found.map((m) => m.id)).toEqual(["a"]);
  });

  it("excludes members holding an excluded role", () => {
    const members = [member("a"), member("b", { roleIds: ["mods"] })];
    expect(eligibleMembers(members, rules({ excludedRoleIds: ["mods"] })).map((m) => m.id)).toEqual(["a"]);
  });

  it("excludes members the bot cannot assign roles to", () => {
    const members = [member("a"), member("owner", { highestRolePosition: 20 })];
    expect(eligibleMembers(members, rules()).map((m) => m.id)).toEqual(["a"]);
  });

  it("keeps The Pakled eligible despite its own role sitting at the top", () => {
    const members = [member(PAKLED, { isBot: true, highestRolePosition: 99 })];
    expect(eligibleMembers(members, rules()).map((m) => m.id)).toEqual([PAKLED]);
  });
});

describe("summariseEligibility", () => {
  it("accounts for every member exactly once, by reason", () => {
    const members = [
      member(PAKLED, { isBot: true, highestRolePosition: 99 }),
      member("a"),
      member("robot", { isBot: true }),
      member("banned", { roleIds: ["mods"] }),
      member("owner", { highestRolePosition: 20 }),
    ];
    const summary = summariseEligibility(members, rules({ excludedRoleIds: ["mods"] }));
    expect(summary).toEqual({ eligible: 2, otherBots: 1, excludedByConfig: 1, aboveTheBot: 1 });
    expect(summary.eligible + summary.otherBots + summary.excludedByConfig + summary.aboveTheBot).toBe(members.length);
  });

  it("agrees with eligibleMembers", () => {
    const members = [member(PAKLED, { isBot: true }), member("a"), member("robot", { isBot: true })];
    expect(summariseEligibility(members, rules()).eligible).toBe(eligibleMembers(members, rules()).length);
  });
});

describe("helmetRoleMap", () => {
  const configured = [helmet("tiny", 1), helmet("biggest", 3)];

  it("maps configured helmets to their provisioned roles", () => {
    const map = helmetRoleMap(configured, [{ helmetId: "tiny", roleId: "r1" }]);
    expect(map.get("tiny")).toBe("r1");
  });

  it("drops a stored row whose helmet is no longer configured", () => {
    // A stale row must never reach a role mutation.
    const map = helmetRoleMap(configured, [
      { helmetId: "tiny", roleId: "r1" },
      { helmetId: "retired", roleId: "some-unrelated-role" },
    ]);
    expect([...map.values()]).toEqual(["r1"]);
    expect(map.has("retired")).toBe(false);
  });
});

describe("memberLabels", () => {
  it("uses the display name when it is unambiguous", () => {
    const labels = memberLabels([member("1", { displayName: "Ann", username: "ann" })]);
    expect(labels.get("1")).toBe("Ann");
  });

  it("disambiguates two accounts sharing a display name", () => {
    const labels = memberLabels([
      member("1", { displayName: "A2597", username: "a2597" }),
      member("2", { displayName: "A2597", username: "a2597_alt" }),
    ]);
    expect(labels.get("1")).toBe("A2597 (@a2597)");
    expect(labels.get("2")).toBe("A2597 (@a2597_alt)");
  });
});

describe("planCeremony", () => {
  const everyone = [member(PAKLED, { isBot: true }), member("a"), member("b")];

  it("assigns every helmet when there are exactly enough Eligible Members", () => {
    const plan = planCeremony(helmets, everyone, PAKLED, seededRandom(1));
    expect(plan.assignments).toHaveLength(3);
    expect(plan.leftoverHelmetIds).toEqual([]);
    expect(new Set(plan.assignments.map((a) => a.memberId))).toEqual(new Set([PAKLED, "a", "b"]));
  });

  it("assigns The Biggest Helmet to exactly one member", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const plan = planCeremony(helmets, everyone, PAKLED, seededRandom(seed));
      expect(plan.assignments.filter((a) => a.helmetId === "biggest")).toHaveLength(1);
    }
  });

  it("always gives The Pakled a helmet (ADR-0001)", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const plan = planCeremony(helmets, everyone, PAKLED, seededRandom(seed));
      expect(plan.assignments.some((a) => a.memberId === PAKLED)).toBe(true);
    }
  });

  it("sometimes gives The Pakled The Biggest Helmet, and sometimes does not", () => {
    const outcomes = new Set<boolean>();
    for (let seed = 1; seed <= 40; seed++) {
      const plan = planCeremony(helmets, everyone, PAKLED, seededRandom(seed));
      outcomes.add(plan.assignments.some((a) => a.memberId === PAKLED && a.helmetId === "biggest"));
    }
    expect(outcomes).toEqual(new Set([true, false]));
  });

  it("leaves helmets in the barrel rather than aborting when members are short", () => {
    const plan = planCeremony(helmets, [member(PAKLED, { isBot: true }), member("a")], PAKLED, seededRandom(3));
    expect(plan.assignments).toHaveLength(2);
    expect(plan.leftoverHelmetIds).toHaveLength(1);
  });

  it("never leaves The Biggest Helmet in the barrel", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const plan = planCeremony(helmets, [member(PAKLED, { isBot: true })], PAKLED, seededRandom(seed));
      expect(plan.leftoverHelmetIds).not.toContain("biggest");
      expect(plan.assignments).toEqual([{ helmetId: "biggest", memberId: PAKLED }]);
    }
  });

  it("produces no assignments when nobody is eligible", () => {
    const plan = planCeremony(helmets, [], PAKLED, seededRandom(1));
    expect(plan.assignments).toEqual([]);
    expect(plan.leftoverHelmetIds).toHaveLength(3);
  });

  it("is reproducible from a seed", () => {
    const a = planCeremony(helmets, everyone, PAKLED, seededRandom(7));
    const b = planCeremony(helmets, everyone, PAKLED, seededRandom(7));
    expect(a).toEqual(b);
  });

  it("produces different plans from different seeds", () => {
    const plans = new Set(
      Array.from({ length: 20 }, (_, i) => JSON.stringify(planCeremony(helmets, everyone, PAKLED, seededRandom(i)))),
    );
    expect(plans.size).toBeGreaterThan(1);
  });
});
