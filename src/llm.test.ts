import { describe, expect, it, vi } from "vitest";
import { loadEnvironment } from "./config.ts";
import {
  FALLBACK_LINES,
  fallbackLine,
  LLMError,
  openRouterProvider,
  parseInterjection,
  parseSpoken,
  rateLimited,
  sanitiseForDiscord,
  type LLMProvider,
} from "./llm.ts";

const okResponse = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe("openRouterProvider", () => {
  it("sends the configured model and the system prompt", async () => {
    const fetch = vi.fn(async () => okResponse("Give back the helmets."));
    const provider = openRouterProvider({ apiKey: "k", model: "some/model", fetch: fetch as never });

    await provider.complete({ system: "you are a pakled", messages: [{ role: "user", content: "hello" }] });

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("some/model");
    expect(body.messages[0]).toEqual({ role: "system", content: "you are a pakled" });
    expect(body.messages[1]).toEqual({ role: "user", content: "hello" });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("asks for the cheapest, plainest configuration: no reasoning, no tools, price-routed", () => {
    // Reasoning models break the JSON contract and exhaust the token budget on
    // thinking, and this bot has nothing to reason about.
    const fetch = vi.fn(async () => okResponse("ok"));
    const provider = openRouterProvider({ apiKey: "k", model: "m", fetch: fetch as never });
    return provider.complete({ system: "s", messages: [], maxTokens: 120 }).then(() => {
      const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.reasoning).toEqual({ enabled: false, effort: "minimal" });
      expect(body.provider).toEqual({ sort: "price" });
      expect(body.tools).toBeUndefined();
      expect(body.max_tokens).toBe(120);
    });
  });

  it("raises a useful error on a non-2xx response", async () => {
    const fetch = vi.fn(async () => new Response("upstream is unwell", { status: 502 }));
    const provider = openRouterProvider({ apiKey: "k", model: "m", fetch: fetch as never });
    await expect(provider.complete({ system: "s", messages: [] })).rejects.toThrow(/502/);
  });

  it("raises rather than returning empty content", async () => {
    const fetch = vi.fn(async () => okResponse("   "));
    const provider = openRouterProvider({ apiKey: "k", model: "m", fetch: fetch as never });
    await expect(provider.complete({ system: "s", messages: [] })).rejects.toThrow(LLMError);
  });
});

describe("rateLimited", () => {
  const provider = (calls: number[]): LLMProvider => ({
    complete: async () => {
      calls.push(clock);
      return "ok";
    },
  });
  let clock = 0;

  it("spaces requests by at least the configured interval", async () => {
    clock = 0;
    const calls: number[] = [];
    const limited = rateLimited(provider(calls), {
      minIntervalMs: 1000,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });

    await Promise.all([limited.complete({ system: "", messages: [] }), limited.complete({ system: "", messages: [] })]);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(1000);
  });

  it("keeps serving after a request fails", async () => {
    clock = 0;
    let n = 0;
    const flaky: LLMProvider = {
      complete: async () => {
        if (++n === 1) throw new Error("boom");
        return "second";
      },
    };
    const limited = rateLimited(flaky, { minIntervalMs: 0, now: () => clock, sleep: async () => {} });
    await expect(limited.complete({ system: "", messages: [] })).rejects.toThrow("boom");
    await expect(limited.complete({ system: "", messages: [] })).resolves.toBe("second");
  });
});

describe("parseInterjection", () => {
  it("accepts a decision to speak", () => {
    expect(parseInterjection('{"shouldRespond":true,"response":"Helmets are good."}')).toEqual({
      shouldRespond: true,
      response: "Helmets are good.",
    });
  });

  it("accepts a decision to stay silent", () => {
    expect(parseInterjection('{"shouldRespond":false}')).toEqual({ shouldRespond: false });
  });

  it("reads JSON out of a code fence", () => {
    expect(parseInterjection('```json\n{"shouldRespond":true,"response":"Hello."}\n```').response).toBe("Hello.");
  });

  it("stays silent on unparseable output", () => {
    expect(parseInterjection("I am not JSON at all")).toEqual({ shouldRespond: false });
  });

  it("stays silent when it claims to speak but says nothing", () => {
    expect(parseInterjection('{"shouldRespond":true,"response":"   "}')).toEqual({ shouldRespond: false });
  });

  it("stays silent when the shape is wrong", () => {
    expect(parseInterjection('{"speak":"yes"}')).toEqual({ shouldRespond: false });
  });
});

describe("parseSpoken", () => {
  it("takes the message from valid JSON", () => {
    expect(parseSpoken('{"message":"Give back the helmets."}', "fb")).toEqual({
      message: "Give back the helmets.",
      usedFallback: false,
    });
  });

  it("accepts a bare line from a model that ignored the contract", () => {
    expect(parseSpoken("The helmet is wrong.", "fb")).toEqual({ message: "The helmet is wrong.", usedFallback: false });
  });

  it("falls back on malformed JSON rather than showing braces to the channel", () => {
    expect(parseSpoken('{"message":', "fb")).toEqual({ message: "fb", usedFallback: true });
  });

  it("falls back on an over-long ramble", () => {
    expect(parseSpoken("x".repeat(600), "fb")).toEqual({ message: "fb", usedFallback: true });
  });
});

describe("fallbackLine", () => {
  it("is always one of the static lines", () => {
    for (let i = 0; i < FALLBACK_LINES.length; i++) {
      expect(FALLBACK_LINES).toContain(fallbackLine(() => i));
    }
  });

  it("never returns empty text", () => {
    expect(fallbackLine(() => 0).length).toBeGreaterThan(0);
  });
});

describe("sanitiseForDiscord", () => {
  it("defangs @everyone and @here so the bot can never mass-ping", () => {
    const safe = sanitiseForDiscord("@everyone give back your helmets")!;
    expect(safe).not.toMatch(/@everyone/);
    expect(safe).toContain("give back your helmets");
    expect(sanitiseForDiscord("@here now")!).not.toMatch(/@here\b/);
  });

  it("clamps text to something Discord will accept", () => {
    expect(sanitiseForDiscord("x".repeat(5000))!.length).toBeLessThanOrEqual(1900);
  });

  it("strips control characters", () => {
    expect(sanitiseForDiscord("hel\u0000lo\u0007")).toBe("hello");
  });

  it("returns null when nothing survives", () => {
    expect(sanitiseForDiscord("   ")).toBeNull();
    expect(sanitiseForDiscord("\u0000")).toBeNull();
  });

  it("leaves ordinary text alone", () => {
    expect(sanitiseForDiscord("The helmet is wrong.")).toBe("The helmet is wrong.");
  });
});

describe("output safety at the parse boundary", () => {
  it("does not let a schema-valid mass ping through", () => {
    expect(parseSpoken('{"message":"@everyone helmets now"}', "fb").message).not.toMatch(/@everyone/);
    expect(parseInterjection('{"shouldRespond":true,"response":"@everyone hi"}').response).not.toMatch(/@everyone/);
  });

  it("treats a whitespace-only message as a failure, not an empty post", () => {
    // .min(1) passes on whitespace; Discord rejects the resulting empty message.
    expect(parseSpoken('{"message":"   "}', "fb")).toEqual({ message: "fb", usedFallback: true });
  });

  it("clamps an over-long schema-valid message", () => {
    expect(parseSpoken(JSON.stringify({ message: "x".repeat(5000) }), "fb").message.length).toBeLessThanOrEqual(1900);
  });

  it("clamps an over-long interjection", () => {
    const raw = JSON.stringify({ shouldRespond: true, response: "y".repeat(5000) });
    expect(parseInterjection(raw).response!.length).toBeLessThanOrEqual(1900);
  });
});

describe("loadEnvironment", () => {
  const base = { DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "g" };

  it("treats the LLM key as optional so the bot still runs without it", () => {
    expect(loadEnvironment(base).openrouterApiKey).toBeNull();
  });

  it("still requires the Discord credentials", () => {
    expect(() => loadEnvironment({ DISCORD_GUILD_ID: "g" })).toThrow(/DISCORD_TOKEN/);
  });

  it("leaves the log level to config.yaml when unset", () => {
    expect(loadEnvironment(base).logLevel).toBeNull();
  });

  it("takes a log level override from the environment", () => {
    expect(loadEnvironment({ ...base, PAKLED_LOG_LEVEL: " DEBUG " }).logLevel).toBe("debug");
  });

  it("refuses a log level it does not recognise rather than logging at the wrong one", () => {
    expect(() => loadEnvironment({ ...base, PAKLED_LOG_LEVEL: "verbose" })).toThrow(/PAKLED_LOG_LEVEL/);
  });
});
