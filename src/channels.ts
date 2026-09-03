/**
 * Which channels The Pakled may wander into. The admin channel is never one of
 * them: it is where failures are reported, and the bot must not chat over its own
 * incident reports. Activity-weighted selection itself arrives with a later ticket.
 */
export type ChannelRules = { adminChannelId: string | null; deny: string[] };

export const selectableChannels = (channelIds: string[], rules: ChannelRules): string[] => {
  const denied = new Set(rules.deny);
  if (rules.adminChannelId !== null) denied.add(rules.adminChannelId);
  return channelIds.filter((id) => !denied.has(id));
};
