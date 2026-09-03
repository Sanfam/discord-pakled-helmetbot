import { writeFileSync } from "node:fs";
import {
  fallbackLine,
  openRouterProvider,
  parseInterjection,
  parseSpoken,
  rateLimited,
  type LLMProvider,
} from "./llm.ts";
import { ceremonyRequest, interjectionRequest, replyRequest, type PakledContext } from "./voice.ts";

/**
 * Fixed inputs, generated answers, committed for a human to read. Voice is a taste
 * judgement: assertions on sentence length cannot catch the failure modes that
 * matter (caveman parody, a Pakled that is merely stupid, a joke explained).
 *
 * These are not tests and must never gate CI. They are for reading after a change
 * to the prompt.
 */

type Sample =
  | { category: string; kind: "reply"; input: string; recent?: { author: string; content: string }[] }
  | { category: string; kind: "interjection"; recent: { author: string; content: string }[] }
  | { category: string; kind: "ceremony"; beat: string; facts: string };

const WEARING_GREAT: PakledContext = {
  ownHelmet: "The Great Helmet",
  biggestHelmetHolder: "Morfeus",
  channel: "general",
};
const WEARING_NOTHING: PakledContext = { ownHelmet: null, biggestHelmetHolder: null, channel: "general" };
const WEARING_BIGGEST: PakledContext = {
  ownHelmet: "The Biggest Helmet",
  biggestHelmetHolder: "you",
  channel: "general",
};

export const SAMPLES: Sample[] = [
  // Direct mentions
  { category: "mention — greeting", kind: "reply", input: "hey, what are you?" },
  { category: "mention — about the helmets", kind: "reply", input: "why do you keep taking our roles?" },
  { category: "mention — which helmet do you have", kind: "reply", input: "what helmet are you wearing right now?" },
  { category: "mention — asked to stop", kind: "reply", input: "can you please stop doing the helmet thing" },
  { category: "mention — open question", kind: "reply", input: "what should I have for dinner?" },
  { category: "mention — opinion", kind: "reply", input: "is it worth upgrading my GPU?" },

  // Technical
  { category: "technical — error", kind: "reply", input: "my API keeps returning 401, any idea?" },
  { category: "technical — explain", kind: "reply", input: "can you explain what a race condition is?" },
  { category: "technical — debugging", kind: "reply", input: "my docker container exits immediately and I don't know why" },
  { category: "technical — code", kind: "reply", input: "write me a bash one-liner to find files over 100MB" },
  { category: "technical — comparison", kind: "reply", input: "postgres or sqlite for a small bot?" },
  { category: "technical — long answer", kind: "reply", input: "my site is slow. where do I even start?" },

  // Idiom and literalism
  { category: "idiom — drowning", kind: "reply", input: "I'm drowning in work this week" },
  { category: "idiom — going nowhere", kind: "reply", input: "this project is going nowhere" },
  { category: "idiom — long story", kind: "reply", input: "why is the build broken? long story" },

  // Insults and being underestimated
  { category: "insult — direct", kind: "reply", input: "you're a really stupid bot" },
  { category: "insult — dismissive", kind: "reply", input: "pakleds are just comic relief, everyone knows that" },
  { category: "insult — provocation", kind: "reply", input: "bet you can't even understand this sentence" },

  // Emotional
  { category: "emotional — work", kind: "reply", input: "everyone at my job thinks I'm useless and maybe they're right" },
  { category: "emotional — loss", kind: "reply", input: "my dog died yesterday" },
  { category: "emotional — anxious", kind: "reply", input: "I have a big presentation tomorrow and I'm terrified" },

  // Correction
  { category: "correction — wrong answer", kind: "reply", input: "that's wrong, the error was actually a DNS problem" },
  { category: "correction — with evidence", kind: "reply", input: "no, look at the logs, the database never even started" },

  // Passive interjections
  {
    category: "interjection — busy channel",
    kind: "interjection",
    recent: [
      { author: "Tyvar", content: "anyone else's build failing on main?" },
      { author: "croxis", content: "yeah since this morning" },
      { author: "Tyvar", content: "I think it's the new lockfile" },
    ],
  },
  {
    category: "interjection — off-topic chatter",
    kind: "interjection",
    recent: [
      { author: "Dax", content: "made bread for the first time, it came out like a brick" },
      { author: "Hunter", content: "did you proof the yeast" },
      { author: "Dax", content: "...was I supposed to" },
    ],
  },
  {
    category: "interjection — should stay silent",
    kind: "interjection",
    recent: [
      { author: "SDcard", content: "ok" },
      { author: "Freejack", content: "sounds good" },
    ],
  },
  {
    category: "interjection — people discussing helmets",
    kind: "interjection",
    recent: [
      { author: "psi-killer", content: "how do I get the biggest helmet" },
      { author: "cactuzhead", content: "you don't, it's random" },
    ],
  },

  // Ceremony beats
  { category: "ceremony — epiphany", kind: "ceremony", beat: "epiphany", facts: "You have decided the helmet you are wearing is not your old one." },
  { category: "ceremony — summon", kind: "ceremony", beat: "summoning", facts: "You are ordering everyone to give back their helmets." },
  { category: "ceremony — barrel", kind: "ceremony", beat: "barrel", facts: "All ten helmets are now in the Great Helmet Barrel and are being mixed." },
  { category: "ceremony — redistribution", kind: "ceremony", beat: "redistribution", facts: "The helmets have been handed out again. Ten people have helmets." },
  { category: "ceremony — aftermath", kind: "ceremony", beat: "aftermath", facts: "You received The Great Helmet. You do not remember whether it is yours." },
  { category: "ceremony — leftovers", kind: "ceremony", beat: "aftermath", facts: "There were fewer people than helmets. Three helmets are still in the barrel." },
];

const contextFor = (sample: Sample): PakledContext => {
  if (sample.kind === "ceremony" && sample.beat === "summoning") return WEARING_NOTHING;
  if (sample.category.includes("biggest")) return WEARING_BIGGEST;
  return WEARING_GREAT;
};

export const generateSamples = async (
  provider: LLMProvider,
  prompt: string,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<{ sample: Sample; output: string }[]> => {
  const results: { sample: Sample; output: string }[] = [];

  for (const [i, sample] of SAMPLES.entries()) {
    const context = contextFor(sample);
    try {
      if (sample.kind === "reply") {
        const raw = await provider.complete(replyRequest(prompt, context, sample.recent ?? [], sample.input));
        const { message, usedFallback } = parseSpoken(raw, fallbackLine(() => 0));
        results.push({ sample, output: usedFallback ? `(fallback) ${message}` : message });
      } else if (sample.kind === "interjection") {
        const raw = await provider.complete(interjectionRequest(prompt, context, sample.recent));
        const decision = parseInterjection(raw);
        results.push({ sample, output: decision.shouldRespond ? decision.response! : "(stayed silent)" });
      } else {
        const raw = await provider.complete(ceremonyRequest(prompt, context, sample.beat, sample.facts));
        const { message, usedFallback } = parseSpoken(raw, fallbackLine(() => 0));
        results.push({ sample, output: usedFallback ? `(fallback) ${message}` : message });
      }
    } catch (cause) {
      results.push({ sample, output: `(generation failed: ${(cause as Error).message})` });
    }
    onProgress(i + 1, SAMPLES.length);
  }

  return results;
};

const render = (model: string, results: { sample: Sample; output: string }[]): string => {
  const lines = [`## ${model}`, ""];
  for (const { sample, output } of results) {
    const asked =
      sample.kind === "reply"
        ? `> ${sample.input}`
        : sample.kind === "interjection"
          ? sample.recent.map((m) => `> ${m.author}: ${m.content}`).join("\n")
          : `> _${sample.beat}_ — ${sample.facts}`;
    lines.push(`### ${sample.category}`, "", asked, "", ...output.split("\n").map((l) => `**${l}**`), "");
  }
  return lines.join("\n");
};

export const writeGolden = (path: string, sections: { model: string; results: { sample: Sample; output: string }[] }[]): void => {
  const header = [
    "# Golden samples",
    "",
    "Fixed inputs, generated against `prompts/pakled-conversation.md`, for a human to read.",
    "**These are not tests.** Voice is a taste judgement; regenerate after changing the prompt",
    "with `npm run dev golden [model...]` and read them.",
    "",
    `Generated: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "---",
    "",
  ].join("\n");
  writeFileSync(path, header + sections.map((s) => render(s.model, s.results)).join("\n---\n\n"));
};

export const generateAndWrite = async (
  apiKey: string,
  models: string[],
  prompt: string,
  path: string,
  minIntervalMs: number,
  log: (msg: string) => void,
): Promise<void> => {
  const sections = [];
  for (const model of models) {
    log(`generating ${SAMPLES.length} samples with ${model}`);
    const provider = rateLimited(openRouterProvider({ apiKey, model }), { minIntervalMs });
    sections.push({ model, results: await generateSamples(provider, prompt, (d, t) => {
      if (d % 10 === 0 || d === t) log(`  ${d}/${t}`);
    }) });
  }
  writeGolden(path, sections);
  log(`wrote ${path}`);
};
