import type { LLMProvider } from "./llm.ts";
import { parseSpoken } from "./llm.ts";
import { replyRequest, type PakledContext } from "./voice.ts";

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
  // Sweeping on every call is quadratic under exactly the burst this exists to
  // survive, so expired entries are cleared only when the map has actually grown.
  let sweepAbove = 64;
  return {
    allow: (key, now) => {
      if (seen.size > sweepAbove) {
        for (const [k, at] of seen) if (now - at >= windowMs) seen.delete(k);
        sweepAbove = Math.max(64, seen.size * 2);
      }
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
/** cleanContent leaves a raw token when the referenced user, role or channel is not
 *  cached. No internal id may reach the model, so strip whatever survived. */
const UNRESOLVED_MENTION = /<[@#][!&]?\d+>/g;

export const reduceHistory = (messages: RawMessage[], limit = 20): ReducedMessage[] =>
  messages
    .map((m) => ({ author: m.authorName, content: m.content.replace(UNRESOLVED_MENTION, "").trim().slice(0, 500) }))
    .filter((m) => m.content.length > 0)
    .slice(-limit);

/** A channel is eligible when it is not denied and, if an allow list exists, is on it. */
/**
 * A thread or forum post inherits its parent's exclusion: denying a channel that
 * has threads under it would otherwise exclude nothing anyone can see.
 */
export const channelAllowed = (
  channelId: string,
  rules: { allow?: string[]; deny: string[]; adminChannelId: string | null },
  parentId?: string | null,
): boolean => {
  const ids = parentId === null || parentId === undefined ? [channelId] : [channelId, parentId];
  if (ids.some((id) => id === rules.adminChannelId)) return false;
  if (ids.some((id) => rules.deny.includes(id))) return false;
  if (rules.allow !== undefined && rules.allow.length > 0) return ids.some((id) => rules.allow!.includes(id));
  return true;
};


/**
 * Answering a direct mention, with every dependency injected so the decisions —
 * who is answered, what the model sees, what happens when it fails — are testable
 * without Discord or a provider.
 *
 * Returns null when the bot should stay quiet. Silence is a valid outcome; an
 * error message in the channel is not.
 */
export const answerMention = async (args: {
  channelId: string;
  parentId?: string | null;
  userId: string;
  question: string;
  now: number;
  channels: { allow?: string[]; deny: string[]; adminChannelId: string | null };
  userCooldown: Cooldown;
  /** A channel-wide gate: a per-user cooldown does not stop fifty people at once. */
  channelCooldown?: Cooldown;
  history: () => Promise<ReducedMessage[]>;
  context: () => Promise<PakledContext>;
  provider: LLMProvider | null;
  prompt: string;
  fallback: () => string;
  onFallback?: (reason: string) => void;
}): Promise<string | null> => {
  if (!channelAllowed(args.channelId, args.channels, args.parentId)) return null;
  if (args.question.trim().length === 0) return null;
  // Per user, so one person cannot monopolise the bot by mentioning it repeatedly.
  if (!args.userCooldown.allow(args.userId, args.now)) return null;
  // Per channel, because a per-user cooldown does nothing against a crowd, and every
  // answer costs a paid request.
  if (args.channelCooldown !== undefined && !args.channelCooldown.allow(args.channelId, args.now)) return null;

  // No provider configured: still answer, in the character's own words.
  if (args.provider === null) {
    args.onFallback?.("no LLM provider configured");
    return args.fallback();
  }

  try {
    const request = replyRequest(args.prompt, await args.context(), await args.history(), args.question);
    const { message, usedFallback } = parseSpoken(await args.provider.complete(request), args.fallback());
    if (usedFallback) args.onFallback?.("model output was unusable");
    return message;
  } catch (cause) {
    // A provider outage must look like the character being terse, never like a
    // broken bot.
    args.onFallback?.((cause as Error).message);
    return args.fallback();
  }
};
