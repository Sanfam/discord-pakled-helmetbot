import { describe, expect, it } from "vitest";
import { applyCeremony, holdersOf, type CeremonyEffects, type Member } from "./ceremony.ts";

const roleByHelmet = new Map([
  ["tiny", "role-tiny"],
  ["biggest", "role-biggest"],
]);
const BIGGEST = "biggest";

/**
 * A guild that remembers who holds what, can be told to fail on the Nth mutation,
 * and records every call so tests can assert that nothing outside the Helmet Set
 * was ever touched.
 */
const fakeGuild = (initial: Record<string, string[]> = {}, failOn?: number) => {
  const roles = new Map<string, Set<string>>(
    Object.entries(initial).map(([memberId, roleIds]) => [memberId, new Set(roleIds)]),
  );
  const calls: string[] = [];
  let n = 0;

  const mutate = (op: "add" | "remove", memberId: string, roleId: string) => {
    calls.push(`${op}:${memberId}:${roleId}`);
    if (++n === failOn) throw new Error(`Discord failed on call ${n}`);
    const held = roles.get(memberId) ?? new Set<string>();
    if (op === "add") held.add(roleId);
    else held.delete(roleId);
    roles.set(memberId, held);
  };

  const effects: CeremonyEffects = {
    addRole: async (memberId, roleId) => mutate("add", memberId, roleId),
    removeRole: async (memberId, roleId) => mutate("remove", memberId, roleId),
  };

  const members = (): Member[] =>
    [...roles.entries()].map(([id, held]) => ({
      id,
      displayName: id,
      username: id,
      isBot: false,
      roleIds: [...held],
      highestRolePosition: 1,
    }));

  return {
    effects,
    calls,
    members,
    readHolders: async (_memberIds: string[]) => holdersOf(members(), roleByHelmet),
    heldBy: (memberId: string) => [...(roles.get(memberId) ?? [])],
  };
};

const plan = { assignments: [{ helmetId: "biggest", memberId: "b" }, { helmetId: "tiny", memberId: "c" }], leftoverHelmetIds: [] };

const run = (guild: ReturnType<typeof fakeGuild>, previous = guild.members()) =>
  applyCeremony({
    plan,
    roleByHelmet,
    biggestHelmetId: BIGGEST,
    previousHolders: holdersOf(previous, roleByHelmet),
    effects: guild.effects,
    readHolders: guild.readHolders,
    onState: () => {},
  });

describe("holdersOf", () => {
  it("maps each helmet to whoever holds its role", () => {
    const members: Member[] = [
      { id: "a", displayName: "a", username: "a", isBot: false, roleIds: ["role-biggest"], highestRolePosition: 1 },
      { id: "b", displayName: "b", isBot: false, roleIds: ["unrelated"], highestRolePosition: 1 },
    ];
    expect(holdersOf(members, roleByHelmet).get("biggest")).toEqual(["a"]);
    expect(holdersOf(members, roleByHelmet).get("tiny")).toEqual([]);
  });
});

describe("applyCeremony", () => {
  it("leaves every planned Helmet Holder wearing their helmet", async () => {
    const guild = fakeGuild({ a: ["role-biggest"], b: [], c: [] });
    const outcome = await run(guild);
    expect(outcome.status).toBe("COMPLETE");
    expect(guild.heldBy("b")).toEqual(["role-biggest"]);
    expect(guild.heldBy("c")).toEqual(["role-tiny"]);
    expect(guild.heldBy("a")).toEqual([]);
  });

  it("collects every helmet before redistributing any", async () => {
    const guild = fakeGuild({ a: ["role-biggest"], b: [], c: [] });
    await run(guild);
    const firstAdd = guild.calls.findIndex((c) => c.startsWith("add:"));
    const lastRemove = guild.calls.map((c) => c.startsWith("remove:")).lastIndexOf(true);
    expect(lastRemove).toBeLessThan(firstAdd);
  });

  it("touches only roles belonging to the Helmet Set", async () => {
    const guild = fakeGuild({ a: ["role-biggest", "some-other-role"], b: [], c: [] });
    await run(guild);
    const touched = new Set(guild.calls.map((c) => c.split(":")[2]));
    expect([...touched].every((roleId) => [...roleByHelmet.values()].includes(roleId!))).toBe(true);
  });

  it("restores previous Helmet Holders when Discord fails during redistribution", async () => {
    const guild = fakeGuild({ a: ["role-biggest"], b: [], c: [] }, 2);
    const outcome = await run(guild, [
      { id: "a", displayName: "a", username: "a", isBot: false, roleIds: ["role-biggest"], highestRolePosition: 1 },
    ]);
    expect(outcome.status).toBe("FAILED");
    expect(outcome.status === "FAILED" && outcome.rolledBack).toBe(true);
    expect(guild.heldBy("a")).toEqual(["role-biggest"]);
    expect(guild.heldBy("b")).toEqual([]);
  });

  it("restores previous Helmet Holders when Discord fails during collection", async () => {
    const guild = fakeGuild({ a: ["role-biggest"], b: [], c: [] }, 1);
    const outcome = await run(guild, [
      { id: "a", displayName: "a", username: "a", isBot: false, roleIds: ["role-biggest"], highestRolePosition: 1 },
    ]);
    expect(outcome.status).toBe("FAILED");
    expect(guild.heldBy("a")).toEqual(["role-biggest"]);
  });

  it("fails rather than trusting the pairing when the result does not verify", async () => {
    const guild = fakeGuild({ a: ["role-biggest"], b: [], c: [] });
    const outcome = await applyCeremony({
      plan,
      roleByHelmet,
      biggestHelmetId: BIGGEST,
      previousHolders: holdersOf(guild.members(), roleByHelmet),
      effects: guild.effects,
      // A guild that quietly disagrees with what we just asked it to do.
      readHolders: async (_ids: string[]) => new Map([["biggest", []], ["tiny", ["c"]]]),
      onState: () => {},
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.status === "FAILED" && outcome.reason).toMatch(/Biggest Helmet/i);
  });

  it("reports when rollback itself could not finish", async () => {
    // Fails on the redistribution call, then again while rolling back.
    const guild = fakeGuild({ a: ["role-biggest"], b: [], c: [] }, 2);
    const brittle = {
      ...guild.effects,
      addRole: async (memberId: string, roleId: string) => {
        await guild.effects.addRole(memberId, roleId);
      },
    };
    const outcome = await applyCeremony({
      plan,
      roleByHelmet,
      biggestHelmetId: BIGGEST,
      previousHolders: holdersOf(guild.members(), roleByHelmet),
      effects: {
        addRole: async () => {
          throw new Error("Discord is down");
        },
        removeRole: brittle.removeRole,
      },
      readHolders: guild.readHolders,
      onState: () => {},
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.status === "FAILED" && outcome.rolledBack).toBe(false);
  });

  it("verifies only the members the Ceremony could have changed", async () => {
    // Reading back the whole guild costs a rate-limited gateway member request,
    // which fails Ceremonies that are otherwise correct.
    const guild = fakeGuild({ a: ["role-biggest"], b: [], c: [], bystander: [] });
    let asked: string[] = [];
    await applyCeremony({
      plan,
      roleByHelmet,
      biggestHelmetId: BIGGEST,
      previousHolders: holdersOf(guild.members(), roleByHelmet),
      effects: guild.effects,
      readHolders: async (ids) => {
        asked = ids;
        return holdersOf(guild.members(), roleByHelmet);
      },
      onState: () => {},
    });
    expect(new Set(asked)).toEqual(new Set(["a", "b", "c"]));
    expect(asked).not.toContain("bystander");
  });

  it("continues rolling back after a compensation fails", async () => {
    // Abandoning the rest leaves the guild worse off than it needs to be.
    const attempted: string[] = [];
    let addCalls = 0;
    const outcome = await applyCeremony({
      plan,
      roleByHelmet,
      biggestHelmetId: BIGGEST,
      previousHolders: new Map([["biggest", ["a"]], ["tiny", ["d"]]]),
      effects: {
        removeRole: async (m, r) => void attempted.push(`remove:${m}:${r}`),
        addRole: async (m, r) => {
          attempted.push(`add:${m}:${r}`);
          if (++addCalls <= 2) throw new Error("Discord is unwell");
        },
      },
      readHolders: async () => new Map(),
      onState: () => {},
    });
    expect(outcome.status).toBe("FAILED");
    // Both collection removals must have been compensated, not just the first.
    expect(attempted.filter((c) => c === "add:a:role-biggest")).toHaveLength(1);
    expect(attempted.filter((c) => c === "add:d:role-tiny")).toHaveLength(1);
  });

  it("refuses a plan that would give one member two helmets", async () => {
    const guild = fakeGuild({ a: [], b: [] });
    const outcome = await applyCeremony({
      plan: { assignments: [{ helmetId: "biggest", memberId: "a" }, { helmetId: "tiny", memberId: "a" }], leftoverHelmetIds: [] },
      roleByHelmet,
      biggestHelmetId: BIGGEST,
      previousHolders: new Map(),
      effects: guild.effects,
      readHolders: guild.readHolders,
      onState: () => {},
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.status === "FAILED" && outcome.reason).toMatch(/more than one helmet/i);
    expect(guild.calls).toEqual([]);
  });

  it("walks the state machine in order", async () => {
    const seen: string[] = [];
    const guild = fakeGuild({ a: ["role-biggest"], b: [], c: [] });
    await applyCeremony({
      plan,
      roleByHelmet,
      biggestHelmetId: BIGGEST,
      previousHolders: holdersOf(guild.members(), roleByHelmet),
      effects: guild.effects,
      readHolders: guild.readHolders,
      onState: (s) => void seen.push(s),
    });
    expect(seen).toEqual(["EPIPHANY", "SUMMON", "COLLECTION", "BARREL", "REDISTRIBUTION", "AFTERMATH", "COMPLETE"]);
  });
});
