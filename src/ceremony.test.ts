import { describe, expect, it } from "vitest";
import {
  activityWeight,
  applyCeremony,
  type CeremonyPlan,
  eligibleMembers,
  weightedDraw,
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

describe("activityWeight", () => {
  const NOW = 1_000_000_000_000;
  const DAY = 86_400_000;
  const tiers = [
    { withinDays: 7, weight: 8 },
    { withinDays: 30, weight: 3 },
  ];

  it("gives a recently active member the top weight", () => {
    expect(activityWeight(NOW - DAY, NOW, tiers, 1)).toBe(8);
  });

  it("gives a middling member the middle weight", () => {
    expect(activityWeight(NOW - 14 * DAY, NOW, tiers, 1)).toBe(3);
  });

  it("gives a long-dormant member the lowest weight, not zero", () => {
    // Nobody is ever permanently excluded.
    expect(activityWeight(NOW - 200 * DAY, NOW, tiers, 1)).toBe(1);
  });

  it("treats a never-seen member as dormant", () => {
    expect(activityWeight(null, NOW, tiers, 1)).toBe(1);
  });

  it("takes the tightest matching tier regardless of tier order", () => {
    const jumbled = [
      { withinDays: 30, weight: 3 },
      { withinDays: 7, weight: 8 },
    ];
    expect(activityWeight(NOW - DAY, NOW, jumbled, 1)).toBe(8);
  });

  it("copes with a timestamp in the future", () => {
    expect(activityWeight(NOW + DAY, NOW, tiers, 1)).toBe(8);
  });
});

describe("weighted planCeremony", () => {
  const NOW = 1_000_000_000_000;
  const active = member("active");
  const dormant = member("dormant");
  const everyone = [member(PAKLED, { isBot: true }), active, dormant];
  const oneHelmet = [helmet("biggest", 1)];
  const byWeight = (m: Member) => (m.id === "active" ? 8 : 1);

  it("prefers active members without excluding dormant ones", () => {
    let activeWins = 0;
    let dormantWins = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const plan = planCeremony(oneHelmet, [active, dormant], "nobody", seededRandom(seed), byWeight);
      if (plan.assignments[0]!.memberId === "active") activeWins++;
      else dormantWins++;
    }
    expect(activeWins).toBeGreaterThan(dormantWins * 2);
    // Never permanently excluded.
    expect(dormantWins).toBeGreaterThan(0);
  });

  it("still always gives The Pakled a helmet, whatever its weight", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const plan = planCeremony(helmets, everyone, PAKLED, seededRandom(seed), () => 0.0001);
      expect(plan.assignments.some((a) => a.memberId === PAKLED)).toBe(true);
    }
  });

  it("degrades to uniform behaviour when every weight is equal", () => {
    // A fresh install has no recorded activity at all.
    const uniform = planCeremony(helmets, everyone, PAKLED, seededRandom(9), () => 1);
    const unweighted = planCeremony(helmets, everyone, PAKLED, seededRandom(9));
    expect(uniform).toEqual(unweighted);
  });

  it("remains reproducible from a seed", () => {
    const a = planCeremony(helmets, everyone, PAKLED, seededRandom(5), byWeight);
    const b = planCeremony(helmets, everyone, PAKLED, seededRandom(5), byWeight);
    expect(a).toEqual(b);
  });

  it("still assigns The Biggest Helmet exactly once", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const plan = planCeremony(helmets, everyone, PAKLED, seededRandom(seed), byWeight);
      expect(plan.assignments.filter((a) => a.helmetId === "biggest")).toHaveLength(1);
    }
  });
});

describe("weightedDraw robustness", () => {
  const items = ["a", "b", "c"];

  it("still draws the unlikely member at a heavy but plausible ratio", () => {
    // Weighted, never filtered: unlikely must not mean impossible.
    const seen = new Set<string>();
    for (let seed = 1; seed <= 4000; seed++) {
      seen.add(weightedDraw(items, (i) => (i === "a" ? 1000 : 1), 1, seededRandom(seed))[0]!);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("clamps an absurd weight ratio so nobody falls off the selection lattice", () => {
    // At 1e12 the light interval would be narrower than the lattice and could never
    // be landed on. Clamping the spread keeps it reachable; it stays vanishingly
    // unlikely, which is proportionality rather than exclusion.
    const drawn = weightedDraw(items, (i) => (i === "a" ? 1e6 : 1e-6), 3, seededRandom(1));
    expect(new Set(drawn)).toEqual(new Set(items));
  });

  it("survives a non-finite weight rather than poisoning every draw", () => {
    const drawn = weightedDraw(items, (i) => (i === "a" ? Infinity : 1), 3, seededRandom(1));
    expect(new Set(drawn)).toEqual(new Set(items));
  });

  it("survives a NaN weight", () => {
    expect(weightedDraw(items, () => NaN, 2, seededRandom(1))).toHaveLength(2);
  });

  it("treats a zero or negative weight as unlikely, not impossible", () => {
    const drawn = weightedDraw(items, (i) => (i === "a" ? 0 : 1), 3, seededRandom(1));
    expect(drawn).toContain("a");
  });

  it("draws without replacement", () => {
    const drawn = weightedDraw(items, () => 1, 3, seededRandom(2));
    expect(new Set(drawn).size).toBe(3);
  });

  it("copes with asking for more than exists, and with nothing at all", () => {
    expect(weightedDraw(items, () => 1, 99, seededRandom(1))).toHaveLength(3);
    expect(weightedDraw([], () => 1, 3, seededRandom(1))).toEqual([]);
  });

  it("respects proportion at ordinary ratios", () => {
    let heavy = 0;
    for (let seed = 1; seed <= 600; seed++) {
      if (weightedDraw(["heavy", "light"], (i) => (i === "heavy" ? 8 : 1), 1, seededRandom(seed))[0] === "heavy") heavy++;
    }
    // 8:1 should land well above half and well short of everything.
    expect(heavy).toBeGreaterThan(400);
    expect(heavy).toBeLessThan(600);
  });
});

describe("Multihat", () => {
  const everyone = [member(PAKLED, { isBot: true }), member("a"), member("b"), member("c")];

  const anyMultihat = (probability: number, seeds = 200) =>
    Array.from({ length: seeds }, (_, i) => planCeremony(helmets, everyone, PAKLED, seededRandom(i), () => 1, probability));

  it("never happens when the probability is zero", () => {
    expect(anyMultihat(0).every((p) => p.multihatMemberId === undefined)).toBe(true);
  });

  it("happens when the probability is one", () => {
    expect(anyMultihat(1, 20).every((p) => p.multihatMemberId !== undefined)).toBe(true);
  });

  it("is rare at a low probability, but does happen", () => {
    const plans = anyMultihat(0.05);
    const struck = plans.filter((p) => p.multihatMemberId !== undefined).length;
    expect(struck).toBeGreaterThan(0);
    expect(struck).toBeLessThan(plans.length / 2);
  });

  it("gives the blessed member exactly two helmets, and nobody else more than one", () => {
    for (const plan of anyMultihat(1, 30)) {
      const counts = new Map<string, number>();
      for (const a of plan.assignments) counts.set(a.memberId, (counts.get(a.memberId) ?? 0) + 1);
      expect(counts.get(plan.multihatMemberId!)).toBe(2);
      expect([...counts.values()].filter((n) => n > 1)).toHaveLength(1);
    }
  });

  it("costs a Helmet Holder rather than a helmet", () => {
    // Ten helmets over nine people: every helmet is still handed out.
    for (const plan of anyMultihat(1, 30)) {
      expect(plan.assignments).toHaveLength(Math.min(helmets.length, everyone.length));
      expect(new Set(plan.assignments.map((a) => a.memberId)).size).toBe(plan.assignments.length - 1);
    }
  });

  it("never takes The Pakled's guaranteed slot away (ADR-0001)", () => {
    for (const plan of anyMultihat(1, 100)) {
      expect(plan.assignments.some((a) => a.memberId === PAKLED)).toBe(true);
    }
  });

  it("still assigns The Biggest Helmet exactly once", () => {
    for (const plan of anyMultihat(1, 50)) {
      expect(plan.assignments.filter((a) => a.helmetId === "biggest")).toHaveLength(1);
    }
  });

  it("can bless The Pakled itself", () => {
    const blessed = anyMultihat(1, 300).map((p) => p.multihatMemberId);
    expect(blessed).toContain(PAKLED);
  });

  it("cannot happen when there is only one helmet to give", () => {
    const plan = planCeremony([helmet("biggest", 1)], everyone, PAKLED, seededRandom(1), () => 1, 1);
    expect(plan.multihatMemberId).toBeUndefined();
  });

  it("remains reproducible from a seed", () => {
    const a = planCeremony(helmets, everyone, PAKLED, seededRandom(7), () => 1, 0.5);
    const b = planCeremony(helmets, everyone, PAKLED, seededRandom(7), () => 1, 0.5);
    expect(a).toEqual(b);
  });
});

describe("the duplicate guard under Multihat", () => {
  const roleByHelmet = new Map([["tiny", "role-tiny"], ["biggest", "role-biggest"]]);
  const noEffects = { addRole: async () => {}, removeRole: async () => {} };

  const apply = (plan: CeremonyPlan) =>
    applyCeremony({
      plan,
      roleByHelmet,
      biggestHelmetId: "biggest",
      previousHolders: new Map(),
      effects: noEffects,
      readHolders: async () => new Map([["biggest", ["m"]], ["tiny", ["m"]]]),
      onState: () => {},
    });

  it("permits a duplicate the plan declared", async () => {
    const outcome = await apply({
      assignments: [{ helmetId: "biggest", memberId: "m" }, { helmetId: "tiny", memberId: "m" }],
      leftoverHelmetIds: [],
      multihatMemberId: "m",
    });
    expect(outcome.status).toBe("COMPLETE");
  });

  it("still refuses a duplicate nobody declared", async () => {
    // The guard exists for accidents, and must keep catching them.
    const outcome = await apply({
      assignments: [{ helmetId: "biggest", memberId: "m" }, { helmetId: "tiny", memberId: "m" }],
      leftoverHelmetIds: [],
    });
    expect(outcome.status).toBe("FAILED");
  });

  it("refuses a duplicate attributed to the wrong member", async () => {
    const outcome = await apply({
      assignments: [{ helmetId: "biggest", memberId: "m" }, { helmetId: "tiny", memberId: "m" }],
      leftoverHelmetIds: [],
      multihatMemberId: "someone-else",
    });
    expect(outcome.status).toBe("FAILED");
  });
});

describe("the duplicate guard rejects malformed declarations", () => {
  it("refuses a declared Multihat that nobody actually has", async () => {
    // Otherwise reverence is conferred on someone wearing one helmet.
    const outcome = await applyCeremony({
      plan: {
        assignments: [{ helmetId: "biggest", memberId: "a" }, { helmetId: "tiny", memberId: "b" }],
        leftoverHelmetIds: [],
        multihatMemberId: "a",
      },
      roleByHelmet: new Map([["tiny", "role-tiny"], ["biggest", "role-biggest"]]),
      biggestHelmetId: "biggest",
      previousHolders: new Map(),
      effects: { addRole: async () => {}, removeRole: async () => {} },
      readHolders: async () => new Map(),
      onState: () => {},
    });
    expect(outcome.status).toBe("FAILED");
  });
});
