import { describe, expect, it, vi } from "vitest";
import type { Message } from "discord.js";
import { isAddressedToBot } from "./addressing.ts";

const asMessage = (overrides: Record<string, unknown> = {}): Message =>
  ({
    channelId: "c1",
    mentions: { users: new Map() },
    reference: undefined,
    channel: { messages: { fetch: vi.fn() } },
    ...overrides,
  }) as unknown as Message;

describe("isAddressedToBot", () => {
  it("recognizes a bot reply when the reply ping is disabled", async () => {
    const fetch = vi.fn(async () => ({ author: { id: "bot" } }));
    const message = asMessage({
      channel: { messages: { fetch } },
      reference: { channelId: "c1", messageId: "m1" },
    });

    await expect(isAddressedToBot(message, "bot")).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith({ message: "m1", cache: false });
  });

  it("rejects a reply to another author", async () => {
    const fetch = vi.fn(async () => ({ author: { id: "other" } }));
    const message = asMessage({
      channel: { messages: { fetch } },
      reference: { channelId: "c1", messageId: "m1" },
    });

    await expect(isAddressedToBot(message, "bot")).resolves.toBe(false);
  });

  it("returns unknown when the reply lookup fails", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("Discord unavailable");
    });
    const message = asMessage({
      channel: { messages: { fetch } },
      reference: { channelId: "c1", messageId: "m1" },
    });

    await expect(isAddressedToBot(message, "bot")).resolves.toBeNull();
  });

  it("does not accept a cross-channel reply reference", async () => {
    const fetch = vi.fn(async () => ({ author: { id: "bot" } }));
    const message = asMessage({
      channel: { messages: { fetch } },
      reference: { channelId: "c2", messageId: "m1" },
    });

    await expect(isAddressedToBot(message, "bot")).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts an explicit bot mention without fetching the reference", async () => {
    const fetch = vi.fn();
    const message = asMessage({
      channel: { messages: { fetch } },
      mentions: { users: new Map([["bot", {}]]) },
      reference: { channelId: "c2", messageId: "m1" },
    });

    await expect(isAddressedToBot(message, "bot")).resolves.toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
