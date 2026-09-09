import type { LLMProvider } from "./llm.ts";
import { parseSpoken } from "./llm.ts";
import { replyRequest, type Asker, type ConversationMessage, type PakledContext } from "./voice.ts";

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
  /** Trusted transient attribution, removed by reduceHistory. */
  authorId?: string;
  /** Routing only; reduceHistory never forwards this id to the model. */
  messageId?: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  createdTimestamp: number;
  /** What the author was wearing when they said it, if anything. */
  helmet?: string | null;
  /** The display name of the message being replied to, if Discord resolved it cheaply. */
  replyToAuthorName?: string | null;
  /** Explicitly mentioned people, reduced to display names at the Discord boundary. */
  mentionedNames?: string[];
};

export type ReducedMessage = ConversationMessage;

/**
 * What the model is allowed to see: display names, text, and short-lived
 * conversation relationships. Embeds, attachments, raw Discord objects and
 * internal ids never leave this boundary, and nothing here is persisted.
 */
/** cleanContent leaves a raw token when the referenced user, role or channel is not
 *  cached. No internal id may reach the model, so strip whatever survived. */
const UNRESOLVED_MENTION = /<[@#][!&]?\d+>/g;

export const reduceHistory = (messages: RawMessage[], limit = 20): ReducedMessage[] =>
  messages
    .map((m) => {
      const reduced: ReducedMessage = {
        author: m.authorName,
        content: m.content.replace(UNRESOLVED_MENTION, "").trim().slice(0, 500),
        helmet: m.helmet ?? null,
        timestamp: m.createdTimestamp,
        isBot: m.authorIsBot,
      };
      if (m.replyToAuthorName !== undefined && m.replyToAuthorName !== null && m.replyToAuthorName.length > 0) {
        reduced.replyTo = m.replyToAuthorName;
      }
      const mentions = [
        ...new Set(
          (m.mentionedNames ?? [])
            .map((name) => name.replace(UNRESOLVED_MENTION, "").trim().slice(0, 100))
            .filter((name) => name.length > 0),
        ),
      ];
      if (mentions.length > 0) reduced.mentions = mentions;
      return reduced;
    })
    .filter((m) => m.content.length > 0)
    .slice(-limit);

/** A non-text reaction or a newer unseen turn must not revive an answered question. */
export const reduceOptionalHistory = (messages: RawMessage[], claimedId: string, limit = 20): ReducedMessage[] | null => {
  const latestHuman = messages.findLast((message) => !message.authorIsBot);
  if (latestHuman?.messageId !== claimedId || reduceHistory([latestHuman], 1).length === 0) return null;
  return reduceHistory(messages, limit);
};

/** Preserve latest-input validation before selecting the exact source window sent to the model. */
export const optionalHistorySources = (messages: RawMessage[], claimedId: string, limit = 20): RawMessage[] | null =>
  reduceOptionalHistory(messages, claimedId, limit) === null ? null :
    messages.filter((m) => reduceHistory([m], 1).length > 0).slice(-limit);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Remove only the bot's direct mention while keeping Discord's resolved names for
 * every other mention. Raw unresolved tokens are removed before the text reaches
 * the model, so an internal Discord id can never become prompt content.
 */
export const sanitizeMentionQuestion = (args: {
  rawContent: string;
  cleanContent: string;
  botId: string;
  botNames?: readonly string[];
}): string => {
  const botMention = new RegExp(`<@!?${escapeRegExp(args.botId)}>`, "g");
  const hadBotMention = botMention.test(args.rawContent);
  let question = args.cleanContent;
  if (hadBotMention) {
    for (const name of args.botNames ?? []) {
      const rendered = new RegExp(`@${escapeRegExp(name)}\\b`, "i");
      if (rendered.test(question)) {
        question = question.replace(rendered, " ");
        break;
      }
    }
  }
  return question.replace(UNRESOLVED_MENTION, "").replace(/\s+/g, " ").trim();
};

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


/** A possessive or incidental "me" is not evidence that the asker is the subject. */
export const durationSubject = (question: string, askerId: string, mentionedIds: string[]): string | null => {
  const ids = [...new Set(mentionedIds)];
  const self = /\bhow (?:long|many (?:days|hours|minutes|weeks|months|years)) (?:have|had|did) I\b/i.test(question);
  if (ids.length === 1 && (!self || ids[0] === askerId)) return ids[0]!;
  return ids.length === 0 && self ? askerId : null;
};

/**
 * Answering a direct mention, with every dependency injected so the decisions —
 * who is answered, what the model sees, what happens when it fails — are testable
 * without Discord or a provider.
 *
 * Returns null when the bot should stay quiet. Silence is a valid outcome; an
 * error message in the channel is not.
 */
export const generateMention = async (args: {
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
  /** Who is speaking, and what they are wearing. Standing colours the answer. */
  asker?: Asker;
  context: () => Promise<PakledContext>;
  provider: LLMProvider | null;
  prompt: string;
  fallback: () => string;
  onFallback?: (reason: string) => void;
  /** Why the bot stayed quiet. Silence has four causes and they are indistinguishable from outside. */
  onDecline?: (reason: string) => void;
  /**
   * Fired once the gates have passed and a model is about to be asked — never
   * before, or the bot would appear to be typing an answer it has already decided
   * not to give.
   */
  onThinking?: () => void;
  canGenerate?: () => Promise<boolean>;
  /** Verified application facts can answer directly, within the same routing/cadence gates. */
  factualReply?: () => Promise<string | null>;
}): Promise<{ message: string; usedFallback: boolean } | null> => {
  if (!channelAllowed(args.channelId, args.channels, args.parentId)) {
    args.onDecline?.("channel is denied or is the admin channel");
    return null;
  }
  if (args.question.trim().length === 0) {
    args.onDecline?.("nothing was asked once the mention was stripped");
    return null;
  }
  // Per user, so one person cannot monopolise the bot by mentioning it repeatedly.
  if (!args.userCooldown.allow(args.userId, args.now)) {
    args.onDecline?.("user is within the mention cooldown");
    return null;
  }
  // Per channel, because a per-user cooldown does nothing against a crowd, and every
  // answer costs a paid request.
  if (args.channelCooldown !== undefined && !args.channelCooldown.allow(args.channelId, args.now)) {
    args.onDecline?.("channel is within the channel cooldown");
    return null;
  }

  if (args.factualReply) {
    try {
      const message = await args.factualReply();
      if (message !== null) return { message, usedFallback: false };
    } catch {
      args.onFallback?.("verified factual answer unavailable");
      return { message: args.fallback(), usedFallback: true };
    }
  }

  // No provider configured: still answer, in the character's own words.
  if (args.provider === null) {
    args.onFallback?.("no LLM provider configured");
    return { message: args.fallback(), usedFallback: true };
  }

  args.onThinking?.();
  try {
    const request = replyRequest(
      args.prompt,
      await args.context(),
      await args.history(),
      args.question,
      args.asker ?? null,
    );
    if (args.canGenerate && !await args.canGenerate()) return { message: args.fallback(), usedFallback: true };
    const { message, usedFallback } = parseSpoken(await args.provider.complete(request,
      args.canGenerate ? { authorize: args.canGenerate } : {}), args.fallback());
    if (usedFallback) args.onFallback?.("model output was unusable");
    return { message, usedFallback };
  } catch (cause) {
    // A provider outage must look like the character being terse, never like a
    // broken bot.
    args.onFallback?.((cause as Error).message);
    return { message: args.fallback(), usedFallback: true };
  }
};

/** Compatibility for callers that only need speech; delivery uses explicit fallback metadata. */
export const answerMention = async (args: Parameters<typeof generateMention>[0]): Promise<string | null> =>
  (await generateMention(args))?.message ?? null;
