import { describe, expect, it } from "vitest";
import { selectableChannels } from "./channels.ts";

describe("selectableChannels", () => {
  it("excludes the admin channel so the bot never chats over its own reports", () => {
    expect(selectableChannels(["general", "ops"], { adminChannelId: "ops", deny: [] })).toEqual(["general"]);
  });

  it("excludes denied channels", () => {
    expect(selectableChannels(["general", "rules"], { adminChannelId: null, deny: ["rules"] })).toEqual(["general"]);
  });

  it("keeps everything when nothing is excluded", () => {
    expect(selectableChannels(["general"], { adminChannelId: null, deny: [] })).toEqual(["general"]);
  });
});
