/**
 * The parts of answering a mention that do not need Discord: who is allowed to be
 * answered right now, and reducing a channel's history to the little the model
 * should see.
 */

export type Cooldown = { allow(key: string, now: number): boolean };

/**
 * One person must not be able to monopolise the bot, and the bot must not be
 * baitable into a message storm in one channel.
 *
 * Entries are dropped once they expire, so a long-running process does not
 * accumulate a key for everyone who has ever spoken.
 */
export const createCooldown = (windowMs: number): Cooldown => {
  const seen = new Map<string, number>();
  return {
    allow: (key, now) => {
      for (const [k, at] of seen) if (now - at >= windowMs) seen.delete(k);
      const last = seen.get(key);
      if (last !== undefined && now - last < windowMs) return false;
      seen.set(key, now);
      return true;
    },
  };
};

export type RawMessage = {
  authorName: string;
  authorIsBot: boolean;
  content: string;
  createdTimestamp: number;
};

export type ReducedMessage = { author: string; content: string };

/**
 * What the model is allowed to see: author name and text, nothing else. Embeds,
 * attachments, raw Discord objects and internal ids never leave this boundary, and
 * nothing here is persisted.
 */
export const reduceHistory = (messages: RawMessage[], limit = 20): ReducedMessage[] =>
  messages
    .filter((m) => m.content.trim().length > 0)
    .slice(-limit)
    .map((m) => ({ author: m.authorName, content: m.content.trim().slice(0, 500) }));

/** A channel is eligible when it is not denied and, if an allow list exists, is on it. */
export const channelAllowed = (
  channelId: string,
  rules: { allow?: string[]; deny: string[]; adminChannelId: string | null },
): boolean => {
  if (rules.adminChannelId === channelId) return false;
  if (rules.deny.includes(channelId)) return false;
  if (rules.allow !== undefined && rules.allow.length > 0) return rules.allow.includes(channelId);
  return true;
};
