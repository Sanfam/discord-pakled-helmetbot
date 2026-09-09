import { afterEach, expect, it, vi } from "vitest";
import { openStore, type Store } from "./store.ts";
import { parseConfig } from "./config.ts";
import { runCeremony } from "./run.ts";
import { createLogger } from "./logger.ts";
const stores: Store[] = [];
const makeStore = () => { const store = openStore(":memory:"); stores.push(store); return store; };
afterEach(() => { stores.splice(0).forEach((s) => s.close()); vi.useRealTimers(); });

it("filters unsuccessful and simulated ceremonies and breaks a run across missing assignments", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const s = makeStore();
  const record = (member: string | null, status: "COMPLETE" | "FAILED", dry = false, guild = "g") => {
    const id = s.beginCeremony(guild, dry);
    if (member) s.recordAssignments(id, [{ helmetId: "b", memberId: member }]);
    s.completeCeremony(id, status);
  };
  record("a", "COMPLETE"); record("b", "FAILED"); record("b", "COMPLETE", true);
  record("foreign", "COMPLETE", false, "other");
  record("a", "COMPLETE");
  expect(s.helmetHistory("g", "b", "a", Date.now())).toMatchObject({ assignments: 2, repeated: true, currentHolderId: "a" });
  record(null, "COMPLETE"); record("b", "COMPLETE");
  expect(s.helmetHistory("g", "b", "a", Date.now())).toMatchObject({ assignments: 2, previousHolderId: null, repeated: false, currentHolderId: "b" });
  const incomplete = s.beginCeremony("g", false);
  s.recordAssignments(incomplete, [{ helmetId: "b", memberId: "unverified" }]);
  expect(s.helmetHistory("g", "b", "a", Date.now()).currentHolderId).toBe("b");
});

it("narrates a verified transient outcome with prior history before COMPLETE is persisted", async () => {
  const s = makeStore();
  const prior = s.beginCeremony("g", false);
  s.recordAssignments(prior, [{ helmetId: "b", memberId: "bot" }]); s.completeCeremony(prior, "COMPLETE");
  const config = parseConfig('helmets: [{id: b, name: Biggest, rank: 1}]\nceremony: {multihatProbability: 0, helmetlessProbability: 0, covetProbability: 0}');
  const member = { id: "bot", displayName: "Pakled", username: "bot", isBot: true, roleIds: ["role"], highestRolePosition: 1 };
  let held = true; let verified = false; let aftermath = false;
  const result = await runCeremony({ config, guildId: "g", pakledId: "bot", members: [member],
    botHighestRolePosition: 10, roleByHelmet: new Map([["b", "role"]]), store: s,
    log: createLogger("error", () => {}), report: async () => true,
    effects: { addRole: async () => { held = true; }, removeRole: async () => { held = false; } },
    readHolders: async () => { verified = true; return new Map([["b", held ? ["bot"] : []]]); },
    narrate: async (beat, facts, current) => {
      if (beat !== "AFTERMATH") return;
      aftermath = true; expect(verified).toBe(true);
      expect(current?.assignments).toEqual([{ helmetId: "b", memberId: "bot" }]);
      expect(s.helmetHistory("g", "b", "bot", Date.now()).assignments).toBe(1);
      expect(facts).toContain("again in this verified outcome");
      expect(facts).not.toContain("never happened");
    },
  });
  expect(result.status).toBe("COMPLETE"); expect(aftermath).toBe(true);
  expect(s.helmetHistory("g", "b", "bot", Date.now()).assignments).toBe(2);
});

it("selects a named logical helmet and suppresses ongoing duration when Discord contradicts the record", async () => {
  const { historyContext, requestedHelmet } = await import("./history-context.ts");
  const s = makeStore();
  const config = parseConfig('helmets: [{id: b, name: Biggest, rank: 2}, {id: tiny, name: Tiny Helmet, rank: 1}]');
  expect(requestedHelmet(config, "What time is it?")).toBeUndefined();
  expect(requestedHelmet(config, "How long have I had it?")?.id).toBe("b");
  expect(requestedHelmet(config, "Who had the Tiny Helmet before?")?.id).toBe("tiny");
  expect(requestedHelmet(config, "Biggest or Tiny Helmet?")).toBeNull();
  s.recordHelmetRole("g", "tiny", "tiny-role");
  const id = s.beginCeremony("g", false); s.recordAssignments(id, [{ helmetId: "tiny", memberId: "u" }]); s.completeCeremony(id, "COMPLETE");
  const guild = { id: "g", members: { fetch: async () => ({ displayName: "Same name", roles: { cache: new Map() } }) } } as never;
  const facts = await historyContext(guild, s, "tiny", ["u"], Date.now(), "Tiny Helmet");
  expect(facts).toContain("no longer wears Tiny Helmet");
  expect(facts).not.toContain("has lasted");
  expect(await historyContext(guild, s, "tiny", ["u", "v"], Date.now(), "Tiny Helmet")).toContain("same display name");
});

it("answers an exact recorded run only when the stable holder still has the observed role", async () => {
  const { historyDurationReply } = await import("./history-context.ts");
  vi.useFakeTimers();
  const start = Date.parse("2026-09-01T00:00:00.000Z");
  const now = start + 6 * 86_400_000 + 2 * 3_600_000 + 3 * 60_000 + 4 * 1_000 + 5;
  vi.setSystemTime(start);
  const s = makeStore();
  s.recordHelmetRole("g", "b", "big-role");
  const ceremony = s.beginCeremony("g", false);
  s.recordAssignments(ceremony, [{ helmetId: "b", memberId: "alice-id" }]);
  s.completeCeremony(ceremony, "COMPLETE");
  const fetch = vi.fn(async ({ user }: { user: string }) => ({
    id: user,
    displayName: user === "alice-id" ? "Alice" : "Other",
    roles: { cache: new Map([["big-role", {}]]) },
  }));
  const guild = { id: "g", members: { fetch } } as never;

  const reply = await historyDurationReply(guild, s, "b", "alice-id", now);
  expect(reply).toContain("Recorded Biggest Helmet assignment run for Alice: 6 days, 2 hours, 3 minutes, 4 seconds, 5 ms.");
  expect(reply).toContain("not proof of uninterrupted Discord role possession");
  expect(fetch).toHaveBeenCalledWith({ user: "alice-id", force: true });
});

it("does not attribute another member's run and makes missing observations unknown", async () => {
  const { historyDurationReply } = await import("./history-context.ts");
  vi.useFakeTimers();
  const s = makeStore();
  s.recordHelmetRole("g", "b", "big-role");
  const first = s.beginCeremony("g", false);
  s.recordAssignments(first, [{ helmetId: "b", memberId: "alice-id" }]);
  s.completeCeremony(first, "COMPLETE");
  const second = s.beginCeremony("g", false);
  s.recordAssignments(second, [{ helmetId: "b", memberId: "bob-id" }]);
  s.completeCeremony(second, "COMPLETE");
  const guild = {
    id: "g",
    members: { fetch: vi.fn(async ({ user }: { user: string }) => {
      if (user === "missing-id") throw new Error("left guild");
      return { id: user, displayName: user === "alice-id" ? "Alice" : "Bob", roles: { cache: new Map() } };
    }) },
  } as never;

  await expect(historyDurationReply(guild, s, "b", "alice-id", Date.now())).resolves.toContain("No current recorded run for Alice");
  await expect(historyDurationReply(guild, s, "b", "missing-id", Date.now())).resolves.toBe("The explicitly identified member could not be resolved. Ask for clarification.");
  await expect(historyDurationReply(guild, s, "b", "bob-id", Date.now())).resolves.toContain("is unknown");
});
