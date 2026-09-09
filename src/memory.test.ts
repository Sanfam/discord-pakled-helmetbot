import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.ts";
import { parseConfig } from "./config.ts";
import { createMemory, memoryEligible, scopeAllows, type MemoryAccess } from "./memory.ts";
import type { Provenance } from "./memory-store.ts";
import { memoryCommands } from "./memory-commands.ts";
import { mayRun, privateCommand } from "./commands.ts";
import { rateLimited } from "./llm.ts";

const source: Provenance = { channelId: "c", categoryId: "cat", audience: "acl", ordinary: true };
const now = Date.now();
const stores: Store[] = [];
const makeStore = () => { const s = openStore(":memory:"); stores.push(s); return s; };
const config = () => parseConfig('helmets: [{id: biggest, name: Biggest, rank: 1}]\nmemory: {enabled: true}');
const write = (store: Store, overrides: Partial<Parameters<Store["writeMemory"]>[0]> = {}) => store.writeMemory({
  guildId: "g", memberId: "u", generation: store.memoryControl("g", "u").generation,
  source, messageId: "m", at: now - 1000, now, retentionDays: 60, maxNotes: 5,
  changes: [{ kind: "upsert", tag: "printer", summary: "I repaired my printer." }], ...overrides,
});
const notes = (s: Store) => s.memoryNotes("g", "u", now, 60);
const access: MemoryAccess = {
  member: async (id) => ({ id, name: "Same display name", roleIds: [], bot: false }),
  source: async (id) => ({ ...source, channelId: id }),
};
afterEach(() => { stores.splice(0).forEach((s) => s.close()); vi.restoreAllMocks(); });

it("does not dispatch queued extraction contents after the member clears memory", async () => {
  const s = makeStore(); write(s);
  let release!: (text: string) => void; let queued!: () => void;
  const waiting = new Promise<void>((r) => { queued = r; });
  const dispatched: string[] = [];
  const limited = rateLimited({ complete: (request) => {
    dispatched.push(request.system);
    return request.system === "blocking" ? new Promise<string>((r) => { release = r; }) : Promise.resolve('{"changes":[]}');
  } }, { minIntervalMs: 0 });
  const blocking = limited.complete({ system: "blocking", messages: [] });
  const m = createMemory({ guildId: "g", config: config(), store: s, access,
    provider: { complete: (request, options) => { const result = limited.complete(request, options); queued(); return result; } } });
  const work = m.learn([{ authorId: "u", messageId: "new", authorName: "u", authorIsBot: false,
    content: "I fixed my printer again.", createdTimestamp: now - 1 }], "c");
  await waiting;
  s.controlMemory("g", "u", { kind: "clear" }, now);
  release("done"); await blocking; await work;
  expect(dispatched).toEqual(["blocking"]);
  expect(notes(s)).toEqual([]);
});

describe("personal memory storage", () => {
  it("defaults off and separates memory exclusions from participation", () => {
    const c = parseConfig('helmets: [{id: b, name: B, rank: 1}]\nparticipants: {excludedUserIds: [u]}');
    expect(c.memory).toMatchObject({ enabled: false, learning: "direct", scope: "channel", retentionDays: 60, maxNotes: 5 });
    const member = { id: "u", name: "u", roleIds: [], bot: false };
    expect(memoryEligible(c, member)).toBe(false);
    c.memory.excludedUserIds = [];
    expect(memoryEligible(c, member)).toBe(true);
    for (const value of [0, -1, 1.5]) expect(() => parseConfig(`helmets: [{id: b, name: B, rank: 1}]\nmemory: {retentionDays: ${value}}`)).toThrow();
  });
  it("isolates guilds, caps notes and renews only on new human evidence", () => {
    const s = makeStore();
    write(s);
    expect(s.memoryNotes("other", "u", now, 60)).toEqual([]);
    const before = notes(s)[0]!;
    s.markMemoryUsed("g", [before.id], now);
    expect(notes(s)[0]!.expiresAt).toBe(before.expiresAt);
    expect(write(s)).toBe(false);
    for (let i = 1; i <= 6; i++) write(s, { at: now - 1000 + i, messageId: `m${i}`, changes: [{ kind: "upsert", tag: `topic${i}`, summary: "Own statement." }] });
    expect(notes(s)).toHaveLength(5);
    expect(notes(s).some((n) => n.tag === "printer")).toBe(false);
  });
  it("deletes whole-topic duplicates without deleting ceremony history", () => {
    const s = makeStore(); write(s);
    write(s, { source: { ...source, channelId: "other" }, at: now - 500, messageId: "new" });
    const ceremony = s.beginCeremony("g", false); s.completeCeremony(ceremony, "COMPLETE");
    expect(notes(s)).toHaveLength(2);
    expect(s.controlMemory("g", "u", { kind: "forget", id: notes(s)[0]!.id, wholeTopic: true }, now)).toBe(2);
    expect(s.ceremonies("g")).toHaveLength(1);
    expect(write(s, { generation: 0 })).toBe(false);
    expect(write(s, { messageId: "fetched-old" })).toBe(false);
  });
  it("applies corrections and retractions without accepting older jobs or other owners", () => {
    const s = makeStore(); write(s);
    const target = notes(s)[0]!.id;
    const oldGeneration = s.memoryControl("g", "u").generation;
    expect(write(s, { at: now - 500, messageId: "correction", changes: [{ kind: "upsert", targetId: target, tag: "printer", summary: "The printer repair was only a plan." }] })).toBe(true);
    expect(write(s, { generation: oldGeneration, at: now - 700, messageId: "older" })).toBe(false);
    write(s, { memberId: "other", generation: 0, changes: [{ kind: "remove", targetId: target, tag: "printer", summary: "" }] });
    expect(notes(s)[0]!.summary).toContain("only a plan");
    write(s, { at: now - 100, messageId: "retract", changes: [{ kind: "remove", targetId: target, tag: "printer", summary: "" }] });
    expect(notes(s)).toEqual([]);
  });
  it("persists opt-outs/cutoffs and physically expires notes while disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-test-"));
    try {
      const path = join(dir, "db"); let s = openStore(path); write(s);
      s.controlMemory("g", "u", { kind: "disable" }, now); s.close();
      s = openStore(path);
      expect(s.memoryControl("g", "u")).toMatchObject({ disabled: true, cutoff: now });
      expect(write(s, { at: now + 1, now: now + 1 })).toBe(false);
      s.controlMemory("g", "u", { kind: "enable" }, now);
      expect(write(s)).toBe(false);
      expect(s.sweepMemory(now + 86400000, 1)).toBe(1);
      expect(s.memoryNotes("g", "u", now, 120)).toEqual([]);
      s.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("never resurrects lowered expiry or renews through inspection", () => {
    const s = makeStore(); write(s);
    s.sweepMemory(now, 30);
    expect(s.memoryNotes("g", "u", now, 120)[0]!.expiresAt).toBe(now - 1000 + 30 * 86400000);
    expect(s.memoryNotes("g", "u", now - 1000 + 30 * 86400000, 120)).toEqual([]);
  });
});

describe("audience containment", () => {
  it.each([
    ["same source", source, source, "channel", true],
    ["channel boundary", source, { ...source, channelId: "d" }, "channel", false],
    ["same category", source, { ...source, channelId: "d" }, "category", true],
    ["cross category", source, { ...source, channelId: "d", categoryId: "other" }, "category", false],
    ["upward", source, { ...source, channelId: "d", categoryId: null }, "category", false],
    ["restricted sibling", source, { ...source, channelId: "d", audience: "restricted" }, "category", false],
    ["downward", { ...source, categoryId: null }, { ...source, channelId: "d" }, "category", true],
    ["private top-level", { ...source, categoryId: null, audience: "private" }, { ...source, channelId: "d" }, "category", false],
    ["thread boundary", { ...source, ordinary: false }, { ...source, channelId: "d" }, "category", false],
  ] as const)("%s", (_label, captured, dest, scope, expected) => {
    expect(scopeAllows(captured, captured, dest, scope)).toBe(expected);
  });
  it("rejects permission/category changes since capture", () => {
    expect(scopeAllows(source, { ...source, audience: "expanded" }, source, "category")).toBe(false);
    expect(scopeAllows(source, { ...source, categoryId: null }, source, "category")).toBe(false);
  });
  it("filters before model input and rechecks permission and generation before dispatch", async () => {
    const s = makeStore(); write(s); const c = config();
    let available = true;
    const m = createMemory({ guildId: "g", config: c, store: s, provider: null,
      access: { ...access, source: async () => available ? source : null } });
    const recall = await m.recall(["u"], "c", now);
    expect(recall.text).toContain("printer");
    available = false;
    expect(await m.validate(recall, "c")).toBe(false);
    expect((await m.recall(["u"], "c", now)).text).toBe("");
    available = true;
    s.controlMemory("g", "u", { kind: "clear" }, now);
    expect(m.valid(recall)).toBe(false);
    expect(await m.validate(recall, "c")).toBe(false);
    expect(m.filterHistory([{ authorId: "u", authorName: "u", authorIsBot: false, content: "old", createdTimestamp: now - 1 }])).toEqual([]);
  });
  it("honors member narrowing, opt-out, global disable and recent-use suppression", async () => {
    const s = makeStore(); write(s); const c = config(); c.memory.scope = "category";
    const m = createMemory({ guildId: "g", config: c, store: s, provider: null, access });
    expect((await m.recall(["u"], "d", now)).notes).toHaveLength(1);
    s.controlMemory("g", "u", { kind: "scope", scope: "channel" }, now);
    expect((await m.recall(["u"], "d", now)).notes).toEqual([]);
    const recall = await m.recall(["u"], "c", now);
    m.used(recall, now);
    expect((await m.recall(["u"], "c", now)).notes).toEqual([]);
    s.controlMemory("g", "u", { kind: "disable" }, now);
    expect((await m.recall(["u"], "c", now + 86400001)).notes).toEqual([]);
    c.memory.enabled = false;
    expect((await m.recall(["u"], "c", now)).notes).toEqual([]);
    expect(notes(s)).toHaveLength(1);
  });
});

describe("extraction and private controls", () => {
  const message = { authorId: "u", messageId: "m", authorName: "Same name", authorIsBot: false, content: "I repaired my printer.", createdTimestamp: now - 1 };
  it("rejects bot/quoted sources and arbitrary source/target identities", async () => {
    const s = makeStore(); const c = config();
    const complete = vi.fn(async () => JSON.stringify({ changes: [
      { source: "made-up", action: "upsert", tag: "bad", summary: "Not mine" },
      { source: "s0", target: "made-up", action: "upsert", tag: "bad", summary: "Not mine" },
      { source: "s0", action: "upsert", tag: "printer", summary: "Repaired a printer" },
    ] }));
    const m = createMemory({ guildId: "g", config: c, store: s, access, provider: { complete } });
    await m.learn([{ ...message, authorIsBot: true }, { ...message, content: "> quoted" }], "c");
    expect(complete).not.toHaveBeenCalled();
    await m.learn([message], "c");
    expect(notes(s).map((n) => n.tag)).toEqual(["printer"]);
    const payload = complete.mock.calls[0]![0];
    expect(JSON.stringify(payload)).not.toContain('"authorId"');
    expect(JSON.stringify(payload)).not.toContain('"memberId"');
  });
  it("drops extraction that finishes after clear or opt-out", async () => {
    const s = makeStore(); let finish!: (s: string) => void; let started!: () => void;
    const began = new Promise<void>((r) => { started = r; });
    const m = createMemory({ guildId: "g", config: config(), store: s, access, provider: {
      complete: () => { started(); return new Promise<string>((r) => { finish = r; }); },
    } });
    const work = m.learn([message], "c"); await began;
    s.controlMemory("g", "u", { kind: "disable", clear: true }, now);
    finish('{"changes":[{"source":"s0","action":"upsert","tag":"printer","summary":"Repaired a printer"}]}');
    await work;
    expect(notes(s)).toEqual([]);
  });
  it("keeps controls private, self-only, and rechecks revoked administrator authority", async () => {
    const s = makeStore(); write(s);
    const caller = { userId: "v", isOwner: false, isAdmin: true };
    let checks = 0;
    const handlers = memoryCommands({ guildId: "g", config: config(), store: s, access, mayInspect: async () => ++checks === 1 });
    expect(mayRun("memory inspect", { ...caller, isAdmin: false })).toBe(true);
    expect(privateCommand("memory inspect")).toBe(true);
    expect(await handlers["memory inspect"]!({ caller, targetUserId: "u", expiration: null })).not.toContain("printer");
    expect(await handlers["memory clear"]!({ caller, targetUserId: "u", expiration: null })).toContain("own");
    const result = await handlers["memory inspect"]!({ caller: { ...caller, userId: "u" }, targetUserId: null, expiration: null });
    expect(result).toContain(notes(s)[0]!.id); expect(result).toContain("Expires:"); expect(result.length).toBeLessThan(2000);
    expect(await handlers["memory clear"]!({ caller: { ...caller, userId: "u" }, targetUserId: null, expiration: null })).toContain("preference is unchanged");
    expect(s.memoryControl("g", "u").disabled).toBe(false);
  });
});

it("deduplicates same-batch tags and learns multiple independent source statements atomically", async () => {
  const s = makeStore();
  const m = createMemory({ guildId: "g", config: config(), store: s, access, provider: {
    complete: async () => JSON.stringify({ changes: [
      { source: "s0", action: "upsert", tag: "printer", summary: "Repaired a printer." },
      { source: "s0", action: "upsert", tag: "printer", summary: "Duplicate." },
      { source: "s1", action: "upsert", tag: "bike", summary: "Owns a bike." },
    ] }),
  } });
  const base = { authorId: "u", authorName: "u", authorIsBot: false };
  const messages = [
    { ...base, messageId: "one", content: "I repaired my printer", createdTimestamp: now - 200 },
    { ...base, messageId: "two", content: "I own a bike", createdTimestamp: now - 100 },
  ];
  await m.learn(messages, "c");
  expect(notes(s).map((n) => n.tag).sort()).toEqual(["bike", "printer"]);
  expect(m.filterHistory(messages)).toHaveLength(2);
  expect(s.memoryControl("g", "u").cutoff).toBe(0);
  const printer = notes(s).find((n) => n.tag === "printer")!;
  write(s, { at: now - 50, messageId: "retraction", changes: [{ kind: "remove", targetId: printer.id, tag: "printer", summary: "" }] });
  await m.learn(messages, "c");
  expect(notes(s).map((n) => n.tag)).toEqual(["bike"]);
});

it("skips empty extraction results on subsequent passes and avoids REST for an empty recall", async () => {
  const s = makeStore();
  const member = vi.fn(access.member); const sourceRead = vi.fn(access.source);
  const complete = vi.fn(async () => '{"changes":[]}');
  const m = createMemory({ guildId: "g", config: config(), store: s,
    access: { member, source: sourceRead }, provider: { complete } });
  expect((await m.recall(["u", "v"], "c", now)).notes).toEqual([]);
  expect(member).not.toHaveBeenCalled(); expect(sourceRead).not.toHaveBeenCalled();
  const msg = { authorId: "u", messageId: "empty-result", authorName: "u", authorIsBot: false,
    content: "Hello", createdTimestamp: now - 1 };
  await m.learn([msg], "c"); await m.learn([msg], "c");
  expect(complete).toHaveBeenCalledTimes(1);
  expect(s.memoryControl("g", "u").cutoff).toBe(0);
  expect(s.memoryControl("g", "u").learnedThrough).toBe(now - 1);
});

it("memoizes per-operation source/member reads and drops colliding display-name recall", async () => {
  const s = makeStore(); write(s);
  write(s, { at: now - 500, messageId: "bike", changes: [{ kind: "upsert", tag: "bike", summary: "Owns a bike." }] });
  const member = vi.fn(access.member); const sourceRead = vi.fn(access.source);
  const m = createMemory({ guildId: "g", config: config(), store: s, access: { member, source: sourceRead }, provider: null });
  const recall = await m.recall(["u"], "c", now);
  expect(recall.notes).toHaveLength(2);
  expect(member).toHaveBeenCalledTimes(1); expect(sourceRead).toHaveBeenCalledTimes(1);
  member.mockClear(); sourceRead.mockClear();
  expect(await m.validate(recall, "c")).toBe(true);
  expect(member).toHaveBeenCalledTimes(1); expect(sourceRead).toHaveBeenCalledTimes(1);
  write(s, { memberId: "v", generation: 0 });
  expect((await m.recall(["u", "v"], "c", now)).text).toBe("");
});

it("allows a corrected note to be recalled instead of retaining the old suppression", () => {
  const s = makeStore(); write(s);
  const old = notes(s)[0]!; s.markMemoryUsed("g", [old.id], now);
  write(s, { at: now - 100, messageId: "changed", changes: [{ kind: "upsert", targetId: old.id, tag: "printer", summary: "Sold the printer." }] });
  expect(notes(s)[0]!.lastUsedAt).toBeNull();
});

it("does not attach a new generation to notes deleted during asynchronous recall reads", async () => {
  const s = makeStore(); write(s);
  const m = createMemory({ guildId: "g", config: config(), store: s, provider: null,
    access: { ...access, source: async () => {
      s.controlMemory("g", "u", { kind: "clear" }, now);
      return source;
    } } });
  expect((await m.recall(["u"], "c", now)).text).toBe("");
  expect(notes(s)).toEqual([]);
});

it("checkpoints an empty extraction without invalidating an existing recall", async () => {
  const s = makeStore(); write(s);
  const m = createMemory({ guildId: "g", config: config(), store: s, access, provider: null });
  const recall = await m.recall(["u"], "c", now);
  const generation = s.memoryControl("g", "u").generation;
  write(s, { at: now - 1, messageId: "no-new-facts", changes: [] });
  expect(s.memoryControl("g", "u")).toMatchObject({ generation, learnedThrough: now - 1 });
  expect(m.valid(recall)).toBe(true);
});

it("reports aggregate memory counts within this guild and retention window", () => {
  const s = makeStore(); write(s);
  write(s, { guildId: "other", memberId: "other" });
  s.controlMemory("g", "optout", { kind: "disable" }, now);
  expect(s.memoryStats("g", now, 60)).toEqual({ stored: 1, active: 1, members: 1, disabled: 1 });
  expect(s.memoryStats("g", now + 61 * 86400000, 60)).toEqual({ stored: 1, active: 0, members: 1, disabled: 1 });
});

it("replaces a same-source topic without an explicit correction target", () => {
  const s = makeStore(); write(s);
  const original = notes(s)[0]!;
  expect(write(s, { at: now - 500, messageId: "correction", changes: [
    { kind: "upsert", tag: "printer", summary: "Uses a different printer now." },
  ] })).toBe(true);
  expect(notes(s)).toHaveLength(1);
  expect(notes(s)[0]).toMatchObject({ id: original.id, summary: "Uses a different printer now.", source: original.source });
});

it("rejects an empty model target instead of treating it as an untargeted upsert", async () => {
  const s = makeStore();
  const m = createMemory({ guildId: "g", config: config(), store: s, access, provider: {
    complete: async () => JSON.stringify({ changes: [{ source: "s0", target: "", action: "upsert", tag: "printer", summary: "Has a printer." }] }),
  } });
  await m.learn([{ authorId: "u", messageId: "new", authorName: "u", authorIsBot: false,
    content: "I bought a printer.", createdTimestamp: now - 1 }], "c");
  expect(notes(s)).toEqual([]);
});
