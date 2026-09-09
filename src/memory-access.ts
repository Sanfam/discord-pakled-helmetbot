import { ChannelType, PermissionsBitField, type Guild } from "discord.js";
import type { Config } from "./config.ts";
import { channelAllowed } from "./mentions.ts";
import type { MemoryAccess } from "./memory.ts";
import type { Provenance } from "./memory-store.ts";

export const discordMemoryAccess = (guild: Guild, config: Config): MemoryAccess => {
  const currentMember: NonNullable<MemoryAccess["currentMember"]> = (id) => {
    const member = guild.members.cache.get(id);
    return member ? { id, name: member.displayName, bot: member.user.bot, roleIds: [...member.roles.cache.keys()] } : null;
  };
  const snapshot = (id: string): Provenance | null => {
    const channel = guild.channels.cache.get(id);
    if (!channel || !channel.isTextBased() || channel.type === ChannelType.PrivateThread) return null;
    if (!channelAllowed(id, { deny: config.channels.deny, adminChannelId: config.channels.adminChannelId }, channel.parentId)) return null;
    const parent = channel.isThread() ? guild.channels.cache.get(channel.parentId!) : channel;
    if (!parent || !("permissionOverwrites" in parent)) return null;
    if (channel.isThread() && channel.archived) return null;
    const bot = guild.members.me;
    if (!bot || !channel.permissionsFor(bot)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory])) return null;
    const mask = PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.Administrator | PermissionsBitField.Flags.ReadMessageHistory;
    const audience = JSON.stringify({
      owner: guild.ownerId,
      roles: [...guild.roles.cache.values()].map((r) => [r.id, String(r.permissions.bitfield & mask)]).sort(),
      overwrites: [...parent.permissionOverwrites.cache.values()].map((o) => [o.id, o.type, String(o.allow.bitfield & mask), String(o.deny.bitfield & mask)]).sort(),
      type: channel.type,
    });
    // ponytail: exact ACL snapshots up to 64 KiB; larger guild policies omit memory until a compact canonical policy is needed.
    if (audience.length > 65536) return null;
    return { channelId: id, categoryId: parent.parentId, audience, ordinary: channel.type === ChannelType.GuildText };
  };
  return {
    currentMember,
    member: async (id) => {
      const member = await guild.members.fetch({ user: id, force: true }).catch(() => null);
      return member ? currentMember(id) : null;
    },
    current: (source) => JSON.stringify(snapshot(source.channelId)) === JSON.stringify(source),
    source: async (id) => {
      try {
        const channel = await guild.channels.fetch(id, { force: true });
        if (!channel) return null;
        if (channel.isThread() && channel.parentId) await guild.channels.fetch(channel.parentId, { force: true });
        await guild.fetch();
        await guild.members.fetchMe({ force: true });
        await guild.roles.fetch();
        return snapshot(id);
      } catch { return null; }
    },
  };
};
