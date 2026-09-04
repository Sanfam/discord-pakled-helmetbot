import { describe, expect, it } from "vitest";
import { channelAllowed, createCooldown, reduceHistory, type RawMessage } from "./mentions.ts";

const message = (over: Partial<RawMessage> = {}): RawMessage => ({
  authorName: "Dax",
  authorIsBot: false,
  content: "hello",
  createdTimestamp: 0,
  ...over,
});

describe("createCooldown", () => {
  it("allows the first request", () => {
    expect(createCooldown(1000).allow("u1", 0)).toBe(true);
  });

  it("blocks a second request inside the window", () => {
    const cd = createCooldown(1000);
    cd.allow("u1", 0);
    expect(cd.allow("u1", 500)).toBe(false);
  });

  it("allows again once the window passes", () => {
    const cd = createCooldown(1000);
    cd.allow("u1", 0);
    expect(cd.allow("u1", 1000)).toBe(true);
  });

  it("tracks keys independently", () => {
    const cd = createCooldown(1000);
    cd.allow("u1", 0);
    expect(cd.allow("u2", 0)).toBe(true);
  });

  it("does not grow without bound", () => {
    // A process running for weeks must not keep a key for everyone who ever spoke.
    const cd = createCooldown(1000);
    for (let i = 0; i < 5000; i++) cd.allow(`u${i}`, i);
    // Everything is long expired by now, so an old key is allowed again immediately.
    expect(cd.allow("u0", 100_000)).toBe(true);
  });
});

describe("reduceHistory", () => {
  it("keeps only author and content", () => {
    expect(reduceHistory([message({ authorName: "Ann", content: "hi" })])).toEqual([{ author: "Ann", content: "hi" }]);
  });

  it("keeps the most recent messages up to the limit", () => {
    const many = Array.from({ length: 50 }, (_, i) => message({ content: `m${i}` }));
    const reduced = reduceHistory(many, 20);
    expect(reduced).toHaveLength(20);
    expect(reduced.at(-1)!.content).toBe("m49");
  });

  it("drops empty messages, which are attachments or embeds with no text", () => {
    expect(reduceHistory([message({ content: "   " }), message({ content: "real" })])).toEqual([
      { author: "Dax", content: "real" },
    ]);
  });

  it("truncates a very long message rather than sending it whole", () => {
    expect(reduceHistory([message({ content: "x".repeat(2000) })])[0]!.content.length).toBe(500);
  });
});

describe("channelAllowed", () => {
  const rules = { deny: [] as string[], adminChannelId: null as string | null };

  it("allows any channel when nothing is configured", () => {
    expect(channelAllowed("c1", rules)).toBe(true);
  });

  it("refuses a denied channel", () => {
    expect(channelAllowed("c1", { ...rules, deny: ["c1"] })).toBe(false);
  });

  it("never answers in the admin channel", () => {
    expect(channelAllowed("ops", { ...rules, adminChannelId: "ops" })).toBe(false);
  });

  it("restricts to the allow list when one is set", () => {
    expect(channelAllowed("c1", { ...rules, allow: ["c2"] })).toBe(false);
    expect(channelAllowed("c2", { ...rules, allow: ["c2"] })).toBe(true);
  });

  it("treats an empty allow list as no restriction", () => {
    expect(channelAllowed("c1", { ...rules, allow: [] })).toBe(true);
  });
});

import { answerMention } from "./mentions.ts";
import type { LLMProvider } from "./llm.ts";
import type { PakledContext } from "./voice.ts";

const context: PakledContext = { ownHelmet: "The Great Helmet", biggestHelmetHolder: "Ann", channel: "general" };
const provider = (reply: string): LLMProvider => ({ complete: async () => reply });
const answering = (over: Partial<Parameters<typeof answerMention>[0]> = {}) =>
  answerMention({
    channelId: "c1",
    userId: "u1",
    question: "why do you take our roles?",
    now: 0,
    channels: { deny: [], adminChannelId: null },
    userCooldown: createCooldown(1000),
    history: async () => [],
    context: async () => context,
    provider: provider('{"message":"We need the helmets."}'),
    prompt: "you are a pakled",
    fallback: () => "The helmet is wrong.",
    ...over,
  });

describe("answerMention", () => {
  it("answers a mention in an allowed channel", async () => {
    expect(await answering()).toBe("We need the helmets.");
  });

  it("says why it stayed quiet, so silence can be told apart from a dead bot", async () => {
    const reasons: string[] = [];
    const userCooldown = createCooldown(1000);
    await answering({ channels: { deny: ["c1"], adminChannelId: null }, onDecline: (r) => reasons.push(r) });
    await answering({ question: "  ", onDecline: (r) => reasons.push(r) });
    await answering({ userCooldown });
    await answering({ userCooldown, now: 100, onDecline: (r) => reasons.push(r) });
    expect(reasons).toEqual([
      "channel is denied or is the admin channel",
      "nothing was asked once the mention was stripped",
      "user is within the mention cooldown",
    ]);
  });

  it("shows it is thinking only once a model is actually going to be asked", async () => {
    const thinking: string[] = [];
    await answering({ onThinking: () => thinking.push("asked") });
    await answering({ question: "  ", onThinking: () => thinking.push("declined") });
    expect(thinking).toEqual(["asked"]);
  });

  it("ignores a mention in a denied channel", async () => {
    expect(await answering({ channels: { deny: ["c1"], adminChannelId: null } })).toBeNull();
  });

  it("ignores a mention in the admin channel", async () => {
    expect(await answering({ channels: { deny: [], adminChannelId: "c1" } })).toBeNull();
  });

  it("ignores an empty question", async () => {
    expect(await answering({ question: "   " })).toBeNull();
  });

  it("stops one person monopolising the bot", async () => {
    const userCooldown = createCooldown(1000);
    expect(await answering({ userCooldown })).not.toBeNull();
    expect(await answering({ userCooldown, now: 100 })).toBeNull();
  });

  it("still answers a different person during that cooldown", async () => {
    const userCooldown = createCooldown(1000);
    await answering({ userCooldown });
    expect(await answering({ userCooldown, userId: "u2", now: 100 })).not.toBeNull();
  });

  it("falls back to a static line when the provider fails", async () => {
    const failing: LLMProvider = {
      complete: async () => {
        throw new Error("provider is down");
      },
    };
    expect(await answering({ provider: failing })).toBe("The helmet is wrong.");
  });

  it("falls back rather than posting unusable model output", async () => {
    // Malformed JSON: leniency covers a model that answers in prose, not one that
    // half-emits a payload and would show braces to the channel.
    expect(await answering({ provider: provider('{"message": broken') })).toBe("The helmet is wrong.");
    expect(await answering({ provider: provider('{"message":"   "}'), userId: "u9" })).toBe("The helmet is wrong.");
  });

  it("answers in character when no provider is configured at all", async () => {
    expect(await answering({ provider: null })).toBe("The helmet is wrong.");
  });

  it("reports why a fallback was used, so an outage is visible", async () => {
    const reasons: string[] = [];
    await answering({ provider: null, onFallback: (r) => void reasons.push(r) });
    expect(reasons).toEqual(["no LLM provider configured"]);
  });

  it("passes the helmet situation to the model so the character can refer to it", async () => {
    let seenSystem = "";
    const spy: LLMProvider = {
      complete: async (req) => {
        seenSystem = req.system;
        return '{"message":"ok"}';
      },
    };
    await answering({ provider: spy });
    expect(seenSystem).toContain("The Great Helmet");
    expect(seenSystem).toContain("Ann");
  });
});

describe("review fixes", () => {
  it("a thread inherits its parent channel's exclusion", () => {
    // Denying a channel that has threads under it would otherwise exclude nothing.
    expect(channelAllowed("thread1", { deny: ["parent1"], adminChannelId: null }, "parent1")).toBe(false);
    expect(channelAllowed("thread1", { deny: [], adminChannelId: "parent1" }, "parent1")).toBe(false);
    expect(channelAllowed("thread1", { deny: [], adminChannelId: null }, "parent1")).toBe(true);
  });

  it("an allow list covers threads of an allowed parent", () => {
    expect(channelAllowed("t", { deny: [], adminChannelId: null, allow: ["p"] }, "p")).toBe(true);
    expect(channelAllowed("t", { deny: [], adminChannelId: null, allow: ["other"] }, "p")).toBe(false);
  });

  it("strips mention tokens that could not be resolved to a name", () => {
    // No internal id may reach the model.
    const reduced = reduceHistory([message({ content: "hello <@123456789> and <#987654321>" })]);
    expect(reduced[0]!.content).not.toMatch(/\d{6}/);
    expect(reduced[0]!.content).toContain("hello");
  });

  it("drops a message that was nothing but an unresolved mention", () => {
    expect(reduceHistory([message({ content: "<@123456789>" })])).toEqual([]);
  });

  it("gates a crowd, not just one talkative person", async () => {
    const channelCooldown = createCooldown(5000);
    const userCooldown = createCooldown(0);
    expect(await answering({ channelCooldown, userCooldown, userId: "a" })).not.toBeNull();
    expect(await answering({ channelCooldown, userCooldown, userId: "b", now: 1 })).toBeNull();
  });

  it("stays cheap under a burst of distinct users", () => {
    // Sweeping on every call is quadratic in exactly the case this guards against.
    const cd = createCooldown(60_000);
    const started = Date.now();
    for (let i = 0; i < 20_000; i++) cd.allow(`u${i}`, i);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
