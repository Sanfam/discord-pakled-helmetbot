import { expect, it } from "vitest";
import { ChannelType, PermissionsBitField, type Guild } from "discord.js";
import { discordMemoryAccess } from "./memory-access.ts";
import { parseConfig } from "./config.ts";

it("uses real Discord permission fields, rejects private threads, and detects moves/revocation", async () => {
  const flags = PermissionsBitField.Flags;
  const role = { id: "everyone", permissions: new PermissionsBitField([flags.ViewChannel, flags.ReadMessageHistory]) };
  const bot = { id: "bot" };
  const c = { id: "c", type: ChannelType.GuildText, parentId: "cat", isThread: () => false,
    isTextBased: () => true, permissionOverwrites: { cache: new Map() },
    permissionsFor: () => role.permissions };
  const thread = { ...c, id: "t", type: ChannelType.PublicThread, parentId: "c", isThread: () => true, archived: false };
  const channels = new Map([ ["c", c], ["t", thread] ]);
  const guild = { ownerId: "owner", fetch: async () => guild,
    channels: { cache: channels, fetch: async (id: string) => channels.get(id) ?? null },
    roles: { cache: new Map([[role.id, role]]), fetch: async () => new Map([[role.id, role]]) },
    members: { me: bot, cache: new Map(), fetchMe: async () => bot },
  } as unknown as Guild;
  const config = parseConfig('helmets: [{id: b, name: B, rank: 1}]');
  const access = discordMemoryAccess(guild, config);
  const snapshot = (await access.source("c"))!;
  expect(snapshot.ordinary).toBe(true); expect(snapshot.categoryId).toBe("cat");
  expect((await access.source("t"))!).toMatchObject({ categoryId: "cat", ordinary: false });
  thread.type = ChannelType.PrivateThread;
  expect(await access.source("t")).toBeNull();
  c.parentId = "different";
  expect(access.current!(snapshot)).toBe(false);
  c.parentId = "cat";
  role.permissions.remove(flags.ViewChannel);
  expect(access.current!(snapshot)).toBe(false);
  expect(await access.source("c")).toBeNull();
  channels.delete("c");
  expect(await access.source("c")).toBeNull();
});
