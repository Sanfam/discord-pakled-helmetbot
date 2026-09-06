import { describe, expect, it } from "vitest";
import { openRouterProvider } from "./llm.ts";

describe("openRouterProvider deadlines", () => {
  it("gives up rather than waiting forever", async () => {
    // A request that never settles is worse than one that fails: the caller holds
    // a mention slot or the passive chain open for as long as the process lives.
    const provider = openRouterProvider({
      apiKey: "k",
      model: "m",
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit).signal!;
          signal.addEventListener("abort", () => reject(signal.reason as Error));
        }),
    });

    await expect(provider.complete({ system: "s", messages: [] })).rejects.toThrow();
  });

  it("passes a deadline on every request", async () => {
    let seen: AbortSignal | null = null;
    const provider = openRouterProvider({
      apiKey: "k",
      model: "m",
      fetch: async (_url, init) => {
        seen = (init as RequestInit).signal ?? null;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      },
    });

    await provider.complete({ system: "s", messages: [] });
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});
