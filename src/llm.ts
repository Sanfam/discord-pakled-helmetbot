import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * One provider interface, one implementation. OpenRouter reaches OpenAI, Anthropic
 * and open models through a single API, which satisfies the "no proprietary
 * dependency" goal at a third of the adapter work. The interface stays so a second
 * implementation is additive rather than a rewrite.
 *
 * The model is a configuration string and is never referenced in logic.
 */

export type LLMMessage = { role: "user" | "assistant"; content: string };
export type LLMRequest = { system: string; messages: LLMMessage[]; maxTokens?: number };
export type LLMProvider = { complete(request: LLMRequest): Promise<string> };

export class LLMError extends Error {}

export const loadPrompt = (path: string): string => {
  try {
    const prompt = readFileSync(path, "utf8").trim();
    if (prompt.length === 0) throw new LLMError(`Prompt file ${path} is empty`);
    return prompt;
  } catch (cause) {
    if (cause instanceof LLMError) throw cause;
    throw new LLMError(`Could not read prompt file ${path}: ${(cause as Error).message}`);
  }
};

/**
 * Deliberately the cheapest, plainest configuration that still sounds like the
 * character:
 *
 * - **Reasoning off.** This bot writes two sentences in a simple voice; there is
 *   nothing to reason about. Reasoning models also break this interface twice over:
 *   their preamble defeats the JSON contract, and their thinking tokens exhaust the
 *   budget so `content` comes back empty. Both were observed in golden samples.
 * - **No tools, ever.** The model decides what the Pakled says and nothing else;
 *   every fact reaches it in the prompt. A tool call here would be a bug.
 * - **Routed by price.** OpenRouter picks the cheapest provider serving the model.
 * - **Tight token ceilings.** Long output is off-character anyway.
 */
export const openRouterProvider = (opts: {
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
}): LLMProvider => ({
  complete: async ({ system, messages, maxTokens }) => {
    const doFetch = opts.fetch ?? globalThis.fetch;
    const response = await doFetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: maxTokens ?? 250,
        temperature: 0.8,
        reasoning: { enabled: false, effort: "minimal" },
        provider: { sort: "price" },
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });

    if (!response.ok) {
      throw new LLMError(`OpenRouter returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new LLMError("OpenRouter returned no content");
    }
    return content.trim();
  },
});

/**
 * A global ceiling on how often any request may be made, so the bot cannot storm
 * the provider however many channels are busy.
 */
export const rateLimited = (
  provider: LLMProvider,
  opts: { minIntervalMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): LLMProvider => {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let queue: Promise<unknown> = Promise.resolve();
  let last = -Infinity;

  return {
    complete: (request) => {
      const run = queue.then(async () => {
        const wait = last + opts.minIntervalMs - now();
        if (wait > 0) await sleep(wait);
        last = now();
        return provider.complete(request);
      });
      // Keep the chain alive even when a call rejects, or one failure stalls the queue.
      queue = run.catch(() => undefined);
      return run;
    },
  };
};

/* ── Structured responses ──────────────────────────────────────────────────── */

/**
 * Discord's hard message limit is 2000 characters; staying under it leaves room for
 * anything the caller prepends.
 */
const DISCORD_SAFE_LENGTH = 1900;

/**
 * Model output is posted verbatim to a channel, so it is untrusted text on its way
 * to an audience — the model may have been steered there by anyone who can type in
 * the server.
 *
 * Returns null when nothing safe survives, which the callers turn into a fallback
 * line or silence rather than a broken or abusive message.
 */
export const sanitiseForDiscord = (text: string): string | null => {
  const cleaned = text
    // C0 control characters, keeping newline and tab.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    // Defang mass pings with a zero-width space. The bot is not granted Mention
    // Everyone, but permissions can be changed by someone who does not know this.
    .replace(/@(everyone|here)\b/gi, "@\u200b$1")
    .trim();

  if (cleaned.length === 0) return null;
  return cleaned.length > DISCORD_SAFE_LENGTH ? `${cleaned.slice(0, DISCORD_SAFE_LENGTH - 1)}…` : cleaned;
};

const interjection = z.object({ shouldRespond: z.boolean(), response: z.string().optional() });
const spoken = z.object({ message: z.string().min(1) });

export type Interjection = { shouldRespond: boolean; response?: string };

/** Models wrap JSON in code fences often enough that not handling it is a bug. */
const unfence = (raw: string): string => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced?.[1] ?? raw).trim();
};

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(unfence(raw));
  } catch {
    return undefined;
  }
};

/**
 * Fallback lines for when the provider is unavailable or answers with nonsense. The
 * bot must keep sounding like itself rather than appearing broken.
 */
export const FALLBACK_LINES = [
  "The helmet is wrong.",
  "I need a better helmet.",
  "Give back the helmets. This is a good plan.",
  "The Great Helmet Barrel is very good.",
  "I will get my old helmet back.",
  "I do not remember what my old helmet looks like.",
  "This is still a good plan.",
  "The Biggest Helmet is supposed to be mine.",
  "I have made a helmet mistake.",
  "I need to think about helmets.",
] as const;

export const fallbackLine = (pick: (max: number) => number): string =>
  FALLBACK_LINES[pick(FALLBACK_LINES.length)] ?? FALLBACK_LINES[0];

/** An unparseable or malformed answer means silence, never a broken-looking message. */
export const parseInterjection = (raw: string): Interjection => {
  const result = interjection.safeParse(parseJson(raw));
  if (!result.success) return { shouldRespond: false };
  const { shouldRespond, response } = result.data;
  if (!shouldRespond || response === undefined) return { shouldRespond: false };
  const safe = sanitiseForDiscord(response);
  return safe === null ? { shouldRespond: false } : { shouldRespond: true, response: safe };
};

/**
 * A beat that must produce words falls back to a static line rather than nothing.
 * Whether the fallback was used is reported, not swallowed: a model that silently
 * fails every call still looks in character, which is how a broken configuration
 * hides. Observed with reasoning models, whose preamble defeats the JSON contract.
 */
export const parseSpoken = (raw: string, fallback: string): { message: string; usedFallback: boolean } => {
  const result = spoken.safeParse(parseJson(raw));
  if (result.success) {
    // .min(1) passes on whitespace, which Discord then rejects as an empty message.
    const safe = sanitiseForDiscord(result.data.message);
    if (safe !== null) return { message: safe, usedFallback: false };
    return { message: fallback, usedFallback: true };
  }
  // A model that ignored the JSON contract but produced a sane short line is still usable.
  const bare = unfence(raw).trim();
  if (bare.length > 0 && bare.length <= 500 && !bare.startsWith("{")) {
    const safe = sanitiseForDiscord(bare);
    if (safe !== null) return { message: safe, usedFallback: false };
  }
  return { message: fallback, usedFallback: true };
};
