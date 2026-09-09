import { expect, it } from "vitest";
import { rateLimited, type LLMProvider } from "./llm.ts";

it("cancels active extraction, replaces pending extraction and dispatches foreground first", async () => {
  const order: string[] = []; let release!: (value: string) => void;
  const provider: LLMProvider = { complete: (request, options) => {
    order.push(request.system);
    if (request.system === "active") return new Promise<string>((resolve, reject) => {
      release = resolve;
      options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")));
    });
    return Promise.resolve(request.system);
  } };
  const p = rateLimited(provider, { minIntervalMs: 0 });
  const active = p.complete({ system: "active", messages: [] }, { priority: "background" }).catch(() => "cancelled");
  const dropped = p.complete({ system: "dropped", messages: [] }, { priority: "background" }).catch(() => "dropped");
  const pending = p.complete({ system: "pending", messages: [] }, { priority: "background" });
  const reply = p.complete({ system: "reply", messages: [] });
  expect(await active).toBe("cancelled"); expect(await dropped).toBe("dropped");
  expect(await reply).toBe("reply"); expect(await pending).toBe("pending");
  expect(order).toEqual(["active", "reply", "pending"]);
  release("unused");
});

it("selects foreground after rate-limit wait instead of reserving a queued extraction", async () => {
  let now = 0; let wake!: () => void; const order: string[] = [];
  const p = rateLimited({ complete: async (r) => { order.push(r.system); return r.system; } }, {
    minIntervalMs: 10, now: () => now,
    sleep: (ms) => new Promise<void>((resolve) => { wake = () => { now += ms; resolve(); }; }),
  });
  await p.complete({ system: "first", messages: [] });
  const background = p.complete({ system: "background", messages: [] }, { priority: "background" });
  const foreground = p.complete({ system: "foreground", messages: [] });
  wake(); await foreground; wake(); await background;
  expect(order).toEqual(["first", "foreground", "background"]);
});

it("rechecks authorization at dispatch after queued data has been invalidated", async () => {
  let release!: (s: string) => void; const order: string[] = []; let permitted = true;
  const p = rateLimited({ complete: (r) => {
    order.push(r.system);
    return r.system === "blocking" ? new Promise<string>((resolve) => { release = resolve; }) : Promise.resolve("ok");
  } }, { minIntervalMs: 0 });
  const blocker = p.complete({ system: "blocking", messages: [] });
  const stale = p.complete({ system: "private notes", messages: [] }, { authorize: () => permitted }).catch(() => "invalidated");
  const extraction = p.complete({ system: "private extraction", messages: [] }, { priority: "background", authorize: () => permitted }).catch(() => "invalidated");
  permitted = false; release("done"); await blocker;
  expect(await stale).toBe("invalidated"); expect(await extraction).toBe("invalidated");
  expect(order).toEqual(["blocking"]);
});
