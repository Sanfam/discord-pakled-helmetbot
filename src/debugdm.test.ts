import { describe, expect, it, vi } from "vitest";
import { createDebugStream, tee } from "./debugdm.ts";
import { createLogger } from "./logger.ts";

const stream = (subscribers: string[]) => {
  const sent: { userId: string; message: string }[] = [];
  const s = createDebugStream({
    subscribers: () => subscribers,
    deliver: async (userId, message) => void sent.push({ userId, message }),
  });
  s.stop();
  return { ...s, sent };
};

describe("createDebugStream", () => {
  it("sends nothing when nobody is watching", async () => {
    const s = stream([]);
    s.logger.info("something happened");
    await s.flush();
    expect(s.sent).toEqual([]);
  });

  it("batches a burst into one message per subscriber", async () => {
    const s = stream(["a", "b"]);
    s.logger.info("one");
    s.logger.warn("two", { channelId: "c1" });
    await s.flush();

    expect(s.sent.map((x) => x.userId)).toEqual(["a", "b"]);
    expect(s.sent[0]!.message).toContain("one");
    expect(s.sent[0]!.message).toContain("two — channelId=c1");
  });

  it("carries debug lines, whatever the console is set to", async () => {
    const s = stream(["a"]);
    s.logger.debug("quiet detail");
    await s.flush();
    expect(s.sent[0]!.message).toContain("quiet detail");
  });

  it("empties the batch once sent", async () => {
    const s = stream(["a"]);
    s.logger.info("one");
    await s.flush();
    await s.flush();
    expect(s.sent).toHaveLength(1);
  });

  it("caps a failure loop at one message rather than hundreds", async () => {
    const s = stream(["a"]);
    for (let i = 0; i < 500; i++) s.logger.error(`failure ${i}`);
    await s.flush();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.message).toMatch(/and \d+ more line\(s\)/);
    expect(s.sent[0]!.message.length).toBeLessThan(2000);
  });

  it("keeps one closed inbox from costing everyone else the batch", async () => {
    const failures: string[] = [];
    const s = createDebugStream({
      subscribers: () => ["closed", "open"],
      deliver: async (userId) => {
        if (userId === "closed") throw new Error("cannot send messages to this user");
      },
      onError: (userId) => failures.push(userId),
    });
    s.stop();
    s.logger.info("one");
    await expect(s.flush()).resolves.toBeUndefined();
    expect(failures).toEqual(["closed"]);
  });

  it("does not hoard lines nobody asked for", async () => {
    // A bot nobody is watching must not grow a buffer for weeks.
    const s = stream([]);
    for (let i = 0; i < 1000; i++) s.logger.info(`line ${i}`);
    const watched = stream(["a"]);
    watched.logger.info("only this one");
    await watched.flush();
    expect(watched.sent[0]!.message).not.toContain("line 999");
  });
});

describe("tee", () => {
  it("writes to both, so the console keeps its own level", () => {
    const console: string[] = [];
    const stream: string[] = [];
    const both = tee(createLogger("info", (l) => console.push(l)), createLogger("debug", (l) => stream.push(l)));

    both.debug("detail");
    both.error("trouble");

    expect(console).toHaveLength(1);
    expect(stream).toHaveLength(2);
  });
});
