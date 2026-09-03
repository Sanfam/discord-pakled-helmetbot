import { Client, GatewayIntentBits, PermissionsBitField, type Guild, type RoleCreateOptions } from "discord.js";
import type { Config } from "./config.ts";
import type { CeremonyEffects, HolderMap, Member } from "./ceremony.ts";
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
