import type { Helmet } from "./config.ts";

/**
 * Everything the readiness check needs to know about a guild, gathered by the
 * Discord adapter. Keeping the check pure over this snapshot means it can be
 * tested without a Discord connection.
 */
export type GuildSnapshot = {
  guildName: string;
  memberCount: number;
  botHighestRolePosition: number;
  missingPermissions: string[];
  /** Existing roles whose name matches a configured helmet, whoever created them. */
  helmetNamedRoles: { name: string; position: number }[];
  /** True once the gateway has accepted our privileged intents: Discord refuses the
   *  connection outright when one is not enabled, so a live connection proves both. */
  intentsAccepted: boolean;
};

export type ReadinessReport = {
  ok: boolean;
  problems: string[];
  notes: string[];
};

export const checkReadiness = (snapshot: GuildSnapshot, helmets: Helmet[]): ReadinessReport => {
  const problems: string[] = [];
  const notes: string[] = [
    `Guild: ${snapshot.guildName} (${snapshot.memberCount} members)`,
    `Helmet Set: ${helmets.length} helmets configured, ${snapshot.helmetNamedRoles.length} already present in the guild`,
  ];

  if (snapshot.missingPermissions.length > 0) {
    problems.push(`Missing permissions: ${snapshot.missingPermissions.join(", ")}. Re-invite the bot with them granted.`);
  } else {
    notes.push("Permissions: View Channels, Send Messages, Read Message History and Manage Roles are all held");
  }

  if (snapshot.intentsAccepted) {
    notes.push("Privileged intents: Server Members and Message Content are enabled");
  } else {
    problems.push("Privileged intents were not accepted by the gateway.");
  }

  if (snapshot.botHighestRolePosition < 1) {
    problems.push(
      "The bot's own role sits at the bottom of the role list, so there is no room to create helmet roles beneath it. Move it up in Server Settings → Roles.",
    );
  }

  const unmanageable = snapshot.helmetNamedRoles.filter((r) => r.position >= snapshot.botHighestRolePosition);
  if (unmanageable.length > 0) {
    problems.push(
      `These helmet roles sit at or above the bot's own role and cannot be managed: ${unmanageable
        .map((r) => r.name)
        .join(", ")}. Drag the bot's role above them in Server Settings → Roles.`,
    );
  }

  if (problems.length === 0) {
    notes.push(`Role hierarchy: the bot's role is at position ${snapshot.botHighestRolePosition}; helmet roles fit beneath it`);
  }

  return { ok: problems.length === 0, problems, notes };
};
