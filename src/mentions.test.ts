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
