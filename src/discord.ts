import {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  type Guild,
  type RoleCreateOptions,
  type TextBasedChannel,
  type TextChannel,
} from "discord.js";
import type { Config } from "./config.ts";
import type { CeremonyEffects, HolderMap, Member } from "./ceremony.ts";
import type { RawMessage } from "./mentions.ts";
import type { PakledContext } from "./voice.ts";
import type { GuildRole, RolePort } from "./helmets.ts";
import type { GuildSnapshot } from "./readiness.ts";

/**
 * The only module that imports discord.js. Engine logic works against snapshots
 * and ports, never against the library, so it stays testable without a gateway.
 */

/** Server Members is needed to enumerate Eligible Members; Message Content to read conversation. */
const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

const REQUIRED_PERMISSIONS = [
  { flag: PermissionsBitField.Flags.ViewChannel, name: "View Channels" },
  { flag: PermissionsBitField.Flags.SendMessages, name: "Send Messages" },
  { flag: PermissionsBitField.Flags.ReadMessageHistory, name: "Read Message History" },
  { flag: PermissionsBitField.Flags.ManageRoles, name: "Manage Roles" },
];

const REASON = "Pakled Helmet Switcher: reconciling the Helmet Set";
const CEREMONY_REASON = "Pakled Helmet Switcher: the Helmet Ceremony";

export class DisallowedIntentsError extends Error {
  constructor() {
    super(
      "Discord refused the connection because a privileged intent is not enabled. " +
        "Enable both SERVER MEMBERS and MESSAGE CONTENT under Bot → Privileged Gateway Intents " +
        "in the Discord Developer Portal. Discord does not say which one is missing, so check both.",
    );
  }
}

export const connect = async (token: string): Promise<Client<true>> => {
  const client = new Client({ intents: INTENTS });
  try {
    await client.login(token);
  } catch (cause) {
    await client.destroy();
    if (/disallowed intents/i.test((cause as Error).message)) throw new DisallowedIntentsError();
    throw cause;
  }
  await new Promise<void>((resolve) => {
    if (client.isReady()) resolve();
    else client.once("clientReady", () => resolve());
  });
  return client as Client<true>;
};

export const openGuild = (client: Client<true>, guildId: string): Promise<Guild> => client.guilds.fetch(guildId);

export const listRoles = async (guild: Guild): Promise<GuildRole[]> =>
  [...(await guild.roles.fetch()).values()].map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    color: r.hexColor,
    hoist: r.hoist,
  }));

export const listMembers = async (guild: Guild): Promise<Member[]> =>
  [...(await guild.members.fetch()).values()].map((m) => ({
    id: m.id,
    displayName: m.displayName,
    username: m.user.username,
    isBot: m.user.bot,
    roleIds: [...m.roles.cache.keys()],
    highestRolePosition: m.roles.highest.position,
  }));

export const snapshotGuild = async (guild: Guild, roles: GuildRole[], config: Config): Promise<GuildSnapshot> => {
  const me = await guild.members.fetchMe();
  const helmetNames = new Set(config.helmets.map((h) => h.name));

  return {
    guildName: guild.name,
    memberCount: guild.memberCount,
    botHighestRolePosition: me.roles.highest.position,
    intentsAccepted: true, // proven by the gateway having accepted this connection
    missingPermissions: REQUIRED_PERMISSIONS.filter((p) => !me.permissions.has(p.flag)).map((p) => p.name),
    helmetNamedRoles: roles.filter((r) => helmetNames.has(r.name)).map((r) => ({ name: r.name, position: r.position })),
  };
};

/**
 * Holders among specific members, read back over REST one member at a time.
 * `guild.members.fetch()` with no id is a *gateway* request (opcode 8), rate
 * limited per guild, so using it to verify a Ceremony fails the Ceremony.
 */
export const holdersAmong = async (
  guild: Guild,
  memberIds: string[],
  roleByHelmet: Map<string, string>,
): Promise<HolderMap> => {
  const members = await Promise.all(
    memberIds.map(async (id) => {
      const member = await guild.members.fetch({ user: id, force: true });
      return { id, roleIds: [...member.roles.cache.keys()] };
    }),
  );
  const holders: HolderMap = new Map([...roleByHelmet.keys()].map((helmetId) => [helmetId, []]));
  for (const member of members) {
    for (const [helmetId, roleId] of roleByHelmet) {
      if (member.roleIds.includes(roleId)) holders.get(helmetId)!.push(member.id);
    }
  }
  return holders;
};

export const memberRolePort = (guild: Guild): CeremonyEffects => ({
  addRole: async (memberId, roleId) => void (await guild.members.addRole({ user: memberId, role: roleId, reason: CEREMONY_REASON })),
  removeRole: async (memberId, roleId) =>
    void (await guild.members.removeRole({ user: memberId, role: roleId, reason: CEREMONY_REASON })),
});

/** Report a failure where an operator will see it. Never throws: a broken admin
 *  channel must not turn a failed Ceremony into a crash. */
export const announce = async (client: Client<true>, channelId: string | null, text: string): Promise<boolean> => {
  if (channelId === null) return false;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel === null || !channel.isTextBased() || !("send" in channel)) return false;
    // Nothing this bot says may ping anyone, whatever the text contains and whatever
    // permissions it is later granted.
    await channel.send({ content: text, allowedMentions: { parse: [] } });
    return true;
  } catch {
    return false;
  }
};

/** Recent channel history, reduced at this boundary: nothing but author and text
 *  leaves it, and nothing is persisted. */
export const recentMessages = async (
  channel: TextBasedChannel,
  limit: number,
  excludeId?: string,
  /** What the author is wearing, from their roles. Omitted, nobody is labelled. */
  helmetOf: (roleIds: string[]) => string | null = () => null,
): Promise<RawMessage[]> => {
  if (!("messages" in channel)) return [];
  // cache: false — history is read for one prompt and must not linger in memory.
  const fetched = await channel.messages.fetch({ limit: Math.min(limit + 1, 100), cache: false });
  return [...fetched.values()]
    .filter((m) => m.id !== excludeId)
    .reverse()
    .map((m) => ({
      authorName: m.member?.displayName ?? m.author.displayName,
      authorIsBot: m.author.bot,
      content: m.cleanContent,
      createdTimestamp: m.createdTimestamp,
      // Only members carry roles. Somebody who has left is simply unlabelled.
      helmet: m.member === null ? null : helmetOf([...m.member.roles.cache.keys()]),
    }));
};

/**
 * roleId -> helmet name, for labelling whoever is speaking. Built per request from
 * config and the roles the bot provisioned, so a renamed helmet is right at once.
 */
export const helmetByRole = (
  helmets: { id: string; name: string; rank: number }[],
  roleByHelmet: Map<string, string>,
): ((roleIds: string[]) => string | null) => {
  const byRole = new Map<string, { name: string; rank: number }>();
  for (const helmet of helmets) {
    const roleId = roleByHelmet.get(helmet.id);
    if (roleId !== undefined) byRole.set(roleId, { name: helmet.name, rank: helmet.rank });
  }
  return (roleIds) => {
    // Somebody wearing two helmets is described by the bigger of them: the Multihat
    // is told to the character separately, and it is the standing that matters here.
    let best: { name: string; rank: number } | null = null;
    for (const roleId of roleIds) {
      const helmet = byRole.get(roleId);
      if (helmet !== undefined && (best === null || helmet.rank > best.rank)) best = helmet;
    }
    return best?.name ?? null;
  };
};

/**
 * What the Pakled is wearing and who holds The Biggest Helmet, taken from the
 * guild's own role membership so it is true even if roles were changed by hand.
 */
export const pakledSituation = async (
  guild: Guild,
  pakledId: string,
  helmets: { id: string; name: string; rank: number }[],
  roleByHelmet: Map<string, string>,
  channelName: string,
  /** Who the last completed Ceremony gave The Biggest Helmet to, if anyone. */
  biggestHelmetHolderId: string | null,
  /** Who the last completed Ceremony blessed with two helmets, if anyone. */
  multihatHolderId: string | null = null,
  /** The helmet the Pakled has fixed on as its own, and who is wearing it. */
  covetedHelmet: { helmetId: string; memberId: string | null } | null = null,
  /** Whether the last Ceremony deliberately left the Pakled with nothing. */
  wentWithout = false,
): Promise<PakledContext> => {
  const byId = new Map(helmets.map((h) => [h.id, h]));
  const ladder = [...helmets].sort((a, b) => a.rank - b.rank);

  /** A member's display name, or null: they may have left, and the character simply
   *  does not know. "you" is not a name and is never looked up. */
  const label = async (memberId: string | null): Promise<string | null> => {
    if (memberId === null) return null;
    if (memberId === pakledId) return "you";
    try {
      return (await guild.members.fetch({ user: memberId })).displayName;
    } catch {
      return null;
    }
  };

  // The bot's own member object is always resolved, so its roles are reliable.
  const me = await guild.members.fetchMe();
  let ownHelmet: string | null = null;
  let ownRank: number | null = null;
  for (const [helmetId, roleId] of roleByHelmet) {
    if (!me.roles.cache.has(roleId)) continue;
    const helmet = byId.get(helmetId);
    if (helmet === undefined) continue;
    // Its own place on the ladder is the biggest thing it is wearing, for the same
    // reason as everyone else's.
    if (ownRank === null || helmet.rank > ownRank) {
      ownHelmet = helmet.name;
      ownRank = helmet.rank;
    }
  }

  // Deliberately not role.members: that filters Discord's member cache, which can be
  // empty after startup in a large guild, and would report that nobody holds The
  // Biggest Helmet while somebody plainly does.
  const biggestHelmetHolder = await label(biggestHelmetHolderId);
  const multihatHolder = await label(multihatHolderId);

  // A helmet the bot no longer has a role for is a helmet that was removed from the
  // config; there is nothing left to covet.
  const covetedName = covetedHelmet === null ? undefined : byId.get(covetedHelmet.helmetId)?.name;
  const coveted =
    covetedHelmet === null || covetedName === undefined
      ? null
      : { helmetName: covetedName, holder: await label(covetedHelmet.memberId) };

  return {
    ownHelmet,
    wentWithout,
    biggestHelmetHolder,
    multihatHolder,
    coveted,
    helmetOrder: ladder.map((h) => h.name),
    // The rank as a position on the ladder, not the configured number: config ranks
    // need not start at one or be contiguous.
    ownRank: ownHelmet === null ? null : ladder.findIndex((h) => h.name === ownHelmet) + 1,
    channel: channelName,
  };
};

/** Channels the bot can actually see and speak in, for passive wandering. */
export const speakableChannels = (guild: Guild, botId: string): { id: string; parentId: string | null }[] =>
  [...guild.channels.cache.values()]
    .filter((c): c is TextChannel => c.type === ChannelType.GuildText)
    .filter((c) => {
      const perms = c.permissionsFor(botId);
      return perms !== null && perms.has(PermissionsBitField.Flags.ViewChannel) && perms.has(PermissionsBitField.Flags.SendMessages);
    })
    .map((c) => ({ id: c.id, parentId: c.parentId }));

/**
 * `onError` exists because a swallowed send is the worst failure this bot has: it
 * decided to speak, nothing appeared, and every log says it worked.
 */
export const sendTo = async (
  guild: Guild,
  channelId: string,
  text: string,
  onError?: (reason: string) => void,
): Promise<boolean> => {
  try {
    const channel = await guild.channels.fetch(channelId);
    if (channel === null || !channel.isTextBased()) {
      onError?.("the channel is missing or is not text-based");
      return false;
    }
    await channel.send({ content: text, allowedMentions: { parse: [] } });
    return true;
  } catch (cause) {
    onError?.((cause as Error).message);
    return false;
  }
};

/**
 * A promise that cannot hang. Narration happens between role mutations, so an
 * unsettled network call would freeze a half-applied Ceremony — and shutdown with
 * it — for as long as the process lives.
 */
export const withTimeout = async <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const rolePort = (guild: Guild): RolePort => ({
  create: async (helmet) => {
    // Helmets are decoration: they grant nothing and cannot be pinged.
    const options: RoleCreateOptions = {
      name: helmet.name,
      hoist: helmet.hoist,
      mentionable: false,
      permissions: [],
      reason: REASON,
    };
    const role = await guild.roles.create(helmet.color === undefined ? options : { ...options, color: helmet.color });
    return role.id;
  },
  update: async (roleId, helmet) => {
    const edits = { name: helmet.name, hoist: helmet.hoist, reason: REASON };
    await guild.roles.edit(roleId, helmet.color === undefined ? edits : { ...edits, color: helmet.color });
  },
  delete: async (roleId) => void (await guild.roles.delete(roleId, REASON)),
});
