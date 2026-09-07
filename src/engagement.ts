/**
 * Short-lived, channel-local conversation state.
 *
 * This module deliberately stores timestamps and message ids only. The caller owns
 * Discord history and scheduling; this policy only decides whether a generation is
 * still about the latest human input.
 */

export const ATTENTION_IDLE_MS = 5 * 60_000;
export const ATTENTION_MAX_MS = 15 * 60_000;
export const OPTIONAL_COOLDOWN_MS = 20 * 60_000;

export type HumanEvent = {
  channelId: string;
  messageId: string;
  at: number;
  direct: boolean;
};

export type BotReplyKind = "direct" | "optional";

export type EngagementToken = Readonly<{
  channelId: string;
  messageId: string;
  inputAt: number;
  revision: number;
  continuation: boolean;
}>;

export type DirectReply = {
  channelId: string;
  inputAt: number;
  now: number;
};

export type EngagementSnapshot = {
  channelId: string;
  revision: number;
  latestHuman: HumanEvent | null;
  lastHumanAt: number | null;
  lastBotAt: number | null;
  lastOptionalAt: number | null;
  attention: boolean;
  attentionExpiresAt: number | null;
  consumedMessageId: string | null;
};

export type EngagementOptions = {
  attentionIdleMs?: number;
  attentionMaxMs?: number;
  optionalCooldownMs?: number;
  retentionMs?: number;
  maxChannels?: number;
};

export type EngagementState = {
  /** Record a human message synchronously, invalidating optional work in flight. */
  onHuman(event: HumanEvent): number;
  /** Update the direct classification of the latest event without recording a new message. */
  markDirect(channelId: string, messageId: string, direct?: boolean): boolean;
  /** Record a successful direct answer. The deadline is based on inputAt, not now. */
  onDirectReply(reply: DirectReply): void;
  /** Record a successfully sent bot message; bot output never renews attention. */
  onBotReply(channelId: string, now: number, kind?: BotReplyKind): void;
  /** Claim the current human input for one optional consideration. */
  claim(channelId: string, now: number, continuation?: boolean): EngagementToken | null;
  /** Reject a generation after any newer human/direct/bot state change or expiry. */
  isCurrent(token: EngagementToken, now: number): boolean;
  /** Whether an unsolicited optional message may be sent in this channel. */
  optionalReady(channelId: string, now: number): boolean;
  /** Read policy state; no message content is retained. */
  snapshot(channelId: string, now: number): EngagementSnapshot;
  /** Drop expired state and enforce the channel bound. */
  prune(now: number): void;
  /** Exposed for cheap operational tests and diagnostics. */
  size(): number;
};

type ChannelState = {
  latestHuman: HumanEvent | null;
  consumedMessageId: string | null;
  lastBotAt: number | null;
  lastOptionalAt: number | null;
  explicitAt: number | null;
  revision: number;
  touchedAt: number;
};

const positive = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;

export const createEngagementState = (options: EngagementOptions = {}): EngagementState => {
  const attentionIdleMs = positive(options.attentionIdleMs, ATTENTION_IDLE_MS);
  const attentionMaxMs = positive(options.attentionMaxMs, ATTENTION_MAX_MS);
  const optionalCooldownMs = positive(options.optionalCooldownMs, OPTIONAL_COOLDOWN_MS);
  const retentionMs = positive(
    options.retentionMs,
    Math.max(attentionIdleMs, attentionMaxMs, optionalCooldownMs),
  );
  const maxChannels = Math.max(
    1,
    Math.floor(positive(options.maxChannels, 256)),
  );

  const channels = new Map<string, ChannelState>();
  let nextRevision = 0;

  const stateFor = (channelId: string, now: number): ChannelState => {
    const existing = channels.get(channelId);
    if (existing !== undefined) {
      existing.touchedAt = Math.max(existing.touchedAt, now);
      return existing;
    }
    const state: ChannelState = {
      latestHuman: null,
      consumedMessageId: null,
      lastBotAt: null,
      lastOptionalAt: null,
      explicitAt: null,
      revision: ++nextRevision,
      touchedAt: now,
    };
    channels.set(channelId, state);
    return state;
  };

  const bump = (state: ChannelState): number => {
    state.revision = ++nextRevision;
    return state.revision;
  };

  const expiry = (state: ChannelState): number | null => {
    if (state.explicitAt === null || state.latestHuman === null) return null;
    return Math.min(
      state.explicitAt + attentionMaxMs,
      state.latestHuman.at + attentionIdleMs,
    );
  };

  const active = (state: ChannelState, now: number): boolean => {
    const expiresAt = expiry(state);
    return expiresAt !== null && now < expiresAt;
  };

  const freshSinceBot = (state: ChannelState): boolean => {
    if (state.latestHuman === null) return false;
    return state.lastBotAt === null || state.latestHuman.at > state.lastBotAt;
  };

  const prune = (now: number): void => {
    for (const [channelId, state] of channels) {
      if (now - state.touchedAt >= retentionMs) channels.delete(channelId);
    }

    if (channels.size <= maxChannels) return;
    const oldest = [...channels.entries()].sort(([, a], [, b]) => a.touchedAt - b.touchedAt);
    for (const [channelId] of oldest.slice(0, channels.size - maxChannels)) {
      channels.delete(channelId);
    }
  };

  const onHuman = (event: HumanEvent): number => {
    prune(event.at);
    const state = stateFor(event.channelId, event.at);
    const latest = state.latestHuman;
    // A verification pass may classify the same Discord event after it was first
    // recorded. It is not a second human input and must not reopen a claim.
    if (latest?.messageId === event.messageId) {
      const changedToDirect = !latest.direct && event.direct;
      state.latestHuman = { ...latest, ...event, direct: event.direct };
      state.touchedAt = Math.max(state.touchedAt, event.at);
      if (changedToDirect) bump(state);
      return state.revision;
    }
    // A replayed older event cannot replace the latest input or reopen attention.
    if (latest !== null && event.at < latest.at) return state.revision;
    // Once the invitation has gone idle, later ordinary chat starts without it.
    // Clearing before replacing latestHuman prevents the new message from
    // accidentally extending an expired invitation.
    if (state.explicitAt !== null && !active(state, event.at)) state.explicitAt = null;

    state.latestHuman = { ...event };
    state.consumedMessageId = null;
    state.touchedAt = Math.max(state.touchedAt, event.at);
    const revision = bump(state);
    prune(event.at);
    return revision;
  };

  const markDirect = (channelId: string, messageId: string, direct = true): boolean => {
    const state = channels.get(channelId);
    if (state?.latestHuman?.messageId !== messageId) return false;
    const changedToDirect = !state.latestHuman.direct && direct;
    state.latestHuman = { ...state.latestHuman, direct };
    if (changedToDirect) bump(state);
    return true;
  };

  const onDirectReply = (reply: DirectReply): void => {
    prune(reply.now);
    const state = stateFor(reply.channelId, reply.now);
    state.explicitAt = state.explicitAt === null ? reply.inputAt : Math.max(state.explicitAt, reply.inputAt);
    // A successful direct response has handled the input even if the caller's
    // subsequent bot-message bookkeeping is interrupted.
    if (state.latestHuman !== null && state.latestHuman.at <= reply.inputAt) {
      state.consumedMessageId = state.latestHuman.messageId;
    }
    state.lastBotAt = Math.max(state.lastBotAt ?? Number.NEGATIVE_INFINITY, reply.now);
    state.touchedAt = Math.max(state.touchedAt, reply.now);
    bump(state);
    prune(reply.now);
  };

  const onBotReply = (channelId: string, now: number, kind: BotReplyKind = "direct"): void => {
    prune(now);
    const state = stateFor(channelId, now);
    state.lastBotAt = Math.max(state.lastBotAt ?? Number.NEGATIVE_INFINITY, now);
    if (kind === "optional") state.lastOptionalAt = Math.max(state.lastOptionalAt ?? Number.NEGATIVE_INFINITY, now);
    // The newest input existed before this output and cannot be evaluated again.
    if (state.latestHuman !== null) state.consumedMessageId = state.latestHuman.messageId;
    state.touchedAt = Math.max(state.touchedAt, now);
    bump(state);
    prune(now);
  };

  const claim = (channelId: string, now: number, continuation = false): EngagementToken | null => {
    prune(now);
    const state = channels.get(channelId);
    if (state === undefined || state.latestHuman === null) return null;
    const latest = state.latestHuman;
    // Mentions and verified replies have their own direct-response path.
    if (latest.direct) return null;
    if (state.consumedMessageId === latest.messageId || !freshSinceBot(state)) return null;
    if (continuation) {
      if (!active(state, now)) return null;
    } else if (!optionalReady(channelId, now)) {
      return null;
    }

    state.consumedMessageId = latest.messageId;
    state.touchedAt = Math.max(state.touchedAt, now);
    return {
      channelId,
      messageId: latest.messageId,
      inputAt: latest.at,
      revision: state.revision,
      continuation,
    };
  };

  const isCurrent = (token: EngagementToken, now: number): boolean => {
    prune(now);
    const state = channels.get(token.channelId);
    if (state === undefined || state.revision !== token.revision) return false;
    if (state.latestHuman?.messageId !== token.messageId || state.consumedMessageId !== token.messageId) return false;
    return !token.continuation || active(state, now);
  };

  const optionalReady = (channelId: string, now: number): boolean => {
    prune(now);
    const state = channels.get(channelId);
    return state === undefined || state.lastOptionalAt === null || now - state.lastOptionalAt >= optionalCooldownMs;
  };

  const snapshot = (channelId: string, now: number): EngagementSnapshot => {
    prune(now);
    const state = channels.get(channelId);
    if (state === undefined) {
      return {
        channelId,
        revision: 0,
        latestHuman: null,
        lastHumanAt: null,
        lastBotAt: null,
        lastOptionalAt: null,
        attention: false,
        attentionExpiresAt: null,
        consumedMessageId: null,
      };
    }
    return {
      channelId,
      revision: state.revision,
      latestHuman: state.latestHuman === null ? null : { ...state.latestHuman },
      lastHumanAt: state.latestHuman?.at ?? null,
      lastBotAt: state.lastBotAt,
      lastOptionalAt: state.lastOptionalAt,
      attention: active(state, now),
      attentionExpiresAt: expiry(state),
      consumedMessageId: state.consumedMessageId,
    };
  };

  return { onHuman, markDirect, onDirectReply, onBotReply, claim, isCurrent, optionalReady, snapshot, prune, size: () => channels.size };
};
