import { Client, GatewayIntentBits, PermissionsBitField } from "discord.js";
import type { Config } from "./config.ts";
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

export const snapshotGuild = async (client: Client<true>, guildId: string, config: Config): Promise<GuildSnapshot> => {
  const guild = await client.guilds.fetch(guildId);
  const me = await guild.members.fetchMe();
  const roles = await guild.roles.fetch();

  const helmetNames = new Set(config.helmets.map((h) => h.name));

  return {
    guildName: guild.name,
    memberCount: guild.memberCount,
    botHighestRolePosition: me.roles.highest.position,
    intentsAccepted: true, // proven by the gateway having accepted this connection
    missingPermissions: REQUIRED_PERMISSIONS.filter((p) => !me.permissions.has(p.flag)).map((p) => p.name),
    helmetNamedRoles: [...roles.values()]
      .filter((r) => helmetNames.has(r.name))
      .map((r) => ({ name: r.name, position: r.position })),
  };
};
