import { describe, expect, it, vi } from "vitest";
import { sendTo } from "./discord.ts";

describe("sendTo", () => {
  it("checks the final guard before posting stale optional output", async () => {
    const send = vi.fn(async () => undefined);
    const channel = { isTextBased: () => true, send };
    let current = true;
    const guild = {
      channels: {
        fetch: vi.fn(async () => {
          current = false;
          return channel;
        }),
      },
    } as never;
    const errors: string[] = [];

    await expect(sendTo(guild, "c1", "old answer", (reason) => errors.push(reason), () => current)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(errors).toEqual(["the send is no longer current"]);
  });
});

it("qualifies a recorded Biggest Helmet holder when observed roles contradict the record", async () => {
  const { pakledSituation } = await import("./discord.ts");
  const held = new Map([["big-role", {}]]);
  const person = { displayName: "Ann", roles: { cache: held } };
  const bot = { displayName: "Pakled", roles: { cache: new Map() } };
  const guild = { members: { fetch: async () => person, fetchMe: async () => bot } } as never;
  const situation = () => pakledSituation(guild, "bot", [{ id: "big", name: "The Biggest Helmet", rank: 1 }], new Map([["big", "big-role"]]), "ceremony", "u");
  expect((await situation()).biggestHelmetHolderUnknown).toBe(false);
  held.clear();
  expect((await situation()).biggestHelmetHolderUnknown).toBe(true);
});
