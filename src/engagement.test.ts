import { describe, expect, it } from "vitest";
import {
  ATTENTION_IDLE_MS,
  ATTENTION_MAX_MS,
  OPTIONAL_COOLDOWN_MS,
  createEngagementState,
  type HumanEvent,
} from "./engagement.ts";

const event = (channelId = "c1", messageId = "m1", at = 0, direct = false): HumanEvent => ({
  channelId,
  messageId,
  at,
  direct,
});

describe("engagement state", () => {
  it("opens attention from the input timestamp, and bot output does not renew it", () => {
    const state = createEngagementState();
    state.onHuman(event("c1", "m1", 0, true));
    state.onDirectReply({ channelId: "c1", inputAt: 0, now: 10 * 60_000 });
    state.onBotReply("c1", 10 * 60_000, "direct");

    expect(state.snapshot("c1", 4 * 60_000).attention).toBe(true);
    expect(state.snapshot("c1", ATTENTION_IDLE_MS).attention).toBe(false);
    expect(state.snapshot("c1", 10 * 60_000).attentionExpiresAt).toBe(ATTENTION_IDLE_MS);
  });

  it("allows an invited follow-up during the optional cooldown", () => {
    const state = createEngagementState();
    state.onHuman(event("c1", "direct", 0, true));
    state.onDirectReply({ channelId: "c1", inputAt: 0, now: 1 });
    state.onBotReply("c1", 1, "direct");
    state.onHuman(event("c1", "follow-up", 2, false));
    state.onBotReply("c1", 2, "optional");
    state.onHuman(event("c1", "continuation", 3, false));

    expect(state.optionalReady("c1", 3)).toBe(false);
    const token = state.claim("c1", 3 + 15_000, true);
    expect(token).not.toBeNull();
    expect(token!.continuation).toBe(true);
    expect(state.isCurrent(token!, 3 + 15_000)).toBe(true);
  });

  it("requires a human message after the last bot response", () => {
    const state = createEngagementState();
    state.onHuman(event("c1", "m1", 0));
    state.onDirectReply({ channelId: "c1", inputAt: 0, now: 1 });
    state.onBotReply("c1", 1, "direct");

    expect(state.claim("c1", 2, true)).toBeNull();
    expect(state.claim("c1", 2, false)).toBeNull();

    state.onHuman(event("c1", "m2", 2));
    expect(state.claim("c1", 15_000 + 2, true)).not.toBeNull();
  });

  it("consumes an input when optional consideration starts", () => {
    const state = createEngagementState();
    state.onHuman(event("c1", "m1", 0));
    const token = state.claim("c1", 1);
    expect(token).not.toBeNull();
    // A declined or failed model decision cannot be retried against the same input.
    expect(state.claim("c1", 2)).toBeNull();

    state.onHuman(event("c1", "m2", 3));
    expect(state.claim("c1", 4)).not.toBeNull();
  });

  it("does not let optional speech consume a direct event", () => {
    const state = createEngagementState();
    state.onHuman(event("c1", "mention", 0, true));
    expect(state.claim("c1", 1)).toBeNull();
    expect(state.claim("c1", 1, true)).toBeNull();
  });

  it("invalidates optional work if an event is upgraded to direct", () => {
    const state = createEngagementState();
    state.onHuman(event("c1", "m1", 0));
    const token = state.claim("c1", 1)!;
    expect(state.markDirect("c1", "m1")).toBe(true);
    expect(state.isCurrent(token, 1)).toBe(false);
  });

  it("invalidates a pending generation on newer human input or bot output", () => {
    const state = createEngagementState();
    state.onHuman(event("c1", "m1", 0));
    const first = state.claim("c1", 1)!;
    state.onHuman(event("c1", "m2", 2));
    expect(state.isCurrent(first, 2)).toBe(false);

    const second = state.claim("c1", 3)!;
    state.onBotReply("c1", 4, "optional");
    expect(state.isCurrent(second, 4)).toBe(false);
  });

  it("ignores an older event replay", () => {
    const state = createEngagementState();
    state.onHuman(event("c1", "new", 10));
    const revision = state.snapshot("c1", 10).revision;
    state.onHuman(event("c1", "replayed", 9));

    expect(state.snapshot("c1", 10).latestHuman?.messageId).toBe("new");
    expect(state.snapshot("c1", 10).revision).toBe(revision);
  });

  it("keeps direct and optional cooldowns separate", () => {
    const state = createEngagementState();
    state.onHuman(event("c1", "direct", 0, true));
    state.onDirectReply({ channelId: "c1", inputAt: 0, now: 1 });
    expect(state.optionalReady("c1", 1)).toBe(true);

    state.onBotReply("c1", 2, "optional");
    expect(state.optionalReady("c1", 2 + OPTIONAL_COOLDOWN_MS - 1)).toBe(false);
    expect(state.optionalReady("c1", 2 + OPTIONAL_COOLDOWN_MS)).toBe(true);
  });

  it("marks a direct classification update without recording a second event", () => {
    const state = createEngagementState();
    state.onHuman(event("c1", "m1", 0));
    const token = state.claim("c1", 1);
    expect(state.markDirect("c1", "m1", false)).toBe(true);
    expect(state.snapshot("c1", 1).latestHuman?.direct).toBe(false);
    expect(state.isCurrent(token!, 1)).toBe(true);
  });

  it("bounds channels and prunes old state", () => {
    const state = createEngagementState({ maxChannels: 2, retentionMs: 100 });
    state.onHuman(event("a", "a1", 0));
    state.onHuman(event("b", "b1", 1));
    state.onHuman(event("c", "c1", 2));
    expect(state.size()).toBe(2);
    state.prune(102);
    expect(state.size()).toBe(0);
  });

  it("expires attention at the explicit fifteen-minute ceiling despite follow-ups", () => {
    const state = createEngagementState();
    state.onHuman(event("c1", "direct", 0, true));
    state.onDirectReply({ channelId: "c1", inputAt: 0, now: 1 });
    state.onBotReply("c1", 1, "direct");
    state.onHuman(event("c1", "follow-up", 4 * 60_000));
    state.onHuman(event("c1", "follow-up-1b", 8 * 60_000));
    state.onHuman(event("c1", "follow-up-2", 12 * 60_000));

    expect(state.snapshot("c1", ATTENTION_MAX_MS - 1).attention).toBe(true);
    expect(state.snapshot("c1", ATTENTION_MAX_MS).attention).toBe(false);
  });

  it("does not revive an invitation after five minutes of idle", () => {
    const state = createEngagementState();
    state.onHuman(event("c1", "direct", 0, true));
    state.onDirectReply({ channelId: "c1", inputAt: 0, now: 1 });
    state.onBotReply("c1", 1, "direct");
    state.onHuman(event("c1", "late-follow-up", ATTENTION_IDLE_MS + 1));

    expect(state.snapshot("c1", ATTENTION_IDLE_MS + 1).attention).toBe(false);
  });
});
