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
