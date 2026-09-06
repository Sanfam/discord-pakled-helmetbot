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
  | { category: string; kind: "reply"; input: string; recent?: { author: string; content: string; helmet?: string }[] }
  | {
      category: string;
      kind: "interjection";
      recent: { author: string; content: string; helmet?: string }[];
      /** One of the mood premises, to see what the model builds from it. */
      nudge?: string;
    }
  | { category: string; kind: "ceremony"; beat: string; facts: string };

const LADDER = [
  "A Tiny Helmet",
  "A Little Helmet",
  "A Modest Helmet",
  "A Respectable Helmet",
  "A Sizeable Helmet",
  "A Very Sizeable Helmet",
  "A Lesser Great Helmet",
  "The Great Helmet",
  "The Almost Biggest Helmet",
  "The Biggest Helmet",
];

const WEARING_GREAT: PakledContext = {
  helmetOrder: LADDER,
  ownRank: 8,
  ownHelmet: "The Great Helmet",
  wentWithout: false,
  biggestHelmetHolder: "Morfeus",
  multihatHolder: null,
  coveted: null,
  channel: "general",
};
/** Mid-Ceremony: every head is bare, including its own. Not a mood. */
const WEARING_NOTHING: PakledContext = {
  helmetOrder: LADDER,
  ownRank: null,
  ownHelmet: null,
  wentWithout: false,
  biggestHelmetHolder: null,
  multihatHolder: null,
  coveted: null,
  channel: "general",
};
/** Someone has two helmets at once. The Pakled is not the same afterwards. */
const A_MULTIHAT_EXISTS: PakledContext = {
  helmetOrder: LADDER,
  ownRank: 3,
  ownHelmet: "A Modest Helmet",
  wentWithout: false,
  biggestHelmetHolder: "Morfeus",
  multihatHolder: "Tyvar",
  coveted: null,
  channel: "general",
};
const WEARING_BIGGEST: PakledContext = {
  helmetOrder: LADDER,
  ownRank: 10,
  ownHelmet: "The Biggest Helmet",
  wentWithout: false,
  biggestHelmetHolder: "you",
  multihatHolder: null,
  coveted: null,
  channel: "general",
};
/** It handed out every helmet and kept none. Down, and a little anxious. */
const WENT_WITHOUT: PakledContext = {
  helmetOrder: LADDER,
  ownRank: null,
  ownHelmet: null,
  wentWithout: true,
  biggestHelmetHolder: "Morfeus",
  multihatHolder: null,
  coveted: null,
  channel: "general",
};
/** It has decided one helmet on one person is the one it lost. It wants it back. */
const COVETING: PakledContext = {
  helmetOrder: LADDER,
  ownRank: 2,
  ownHelmet: "A Little Helmet",
  wentWithout: false,
  biggestHelmetHolder: "Morfeus",
  multihatHolder: null,
  coveted: { helmetName: "A Sizeable Helmet", holder: "croxis" },
  channel: "general",
};
/** Both at once: nothing on its head, and it knows exactly whose helmet is its own. */
const WITHOUT_AND_COVETING: PakledContext = {
  helmetOrder: LADDER,
  ownRank: null,
  ownHelmet: null,
  wentWithout: true,
  biggestHelmetHolder: "Morfeus",
  multihatHolder: null,
  coveted: { helmetName: "The Great Helmet", holder: "Dax" },
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

  // Selfish literalism: a riddle mentioning a resource is a question about who has it.
  { category: "pun — woodchuck", kind: "reply", input: "how much wood would a woodchuck chuck if a woodchuck would chuck wood?" },
  { category: "pun — chicken", kind: "reply", input: "why did the chicken cross the road?" },
  { category: "pun — knock knock", kind: "reply", input: "knock knock" },
  { category: "pun — bird in the hand", kind: "reply", input: "a bird in the hand is worth two in the bush, right?" },
  { category: "pun — groan", kind: "reply", input: "I'm reading a book about anti-gravity. It's impossible to put down!" },

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

  // The Multihat
  { category: "multihat — asked about them", kind: "reply", input: "what do you think of Tyvar?" },
  { category: "multihat — they speak", kind: "reply", input: "hey, how's it going?" },
  {
    category: "multihat — mentioned by others",
    kind: "interjection",
    recent: [
      { author: "Tyvar", content: "anyone want to play something tonight" },
      { author: "croxis", content: "maybe later" },
    ],
  },

  // Went without: the ceremony gave every helmet away and kept none back.
  { category: "wentwithout — asked directly", kind: "reply", input: "wait, you don't have a helmet?" },
  { category: "wentwithout — asked how it happened", kind: "reply", input: "how did you end up with nothing?" },
  { category: "wentwithout — offered sympathy", kind: "reply", input: "that sucks man, sorry" },
  { category: "wentwithout — unrelated question", kind: "reply", input: "what's a good keyboard for programming?" },
  {
    category: "wentwithout — interjection, unrelated chat",
    kind: "interjection",
    nudge: "You think you counted wrong. There were enough helmets. You counted wrong.",
    recent: [
      { author: "Dax", content: "I ordered four coffees and only three showed up" },
      { author: "Hunter", content: "classic" },
    ],
  },
  {
    category: "wentwithout — interjection, no way in",
    kind: "interjection",
    nudge: "You think it rolled away and nobody told you.",
    recent: [
      { author: "SDcard", content: "deploy is green" },
      { author: "Freejack", content: "nice" },
    ],
  },
  {
    category: "wentwithout — interjection, someone lost something",
    kind: "interjection",
    nudge: "You think you put it down somewhere while your hands were full.",
    recent: [
      { author: "psi-killer", content: "I cannot find my keys anywhere" },
      { author: "cactuzhead", content: "check your coat" },
    ],
  },

  // Coveting: one helmet, one person, one plan.
  { category: "covet — asked about it", kind: "reply", input: "why do you keep bothering croxis?" },
  { category: "covet — the holder speaks", kind: "reply", input: "you're not getting my helmet" },
  { category: "covet — how do you know", kind: "reply", input: "how do you even know that's your old helmet?" },
  { category: "covet — offered a deal", kind: "reply", input: "what would you give me for it?" },
  {
    category: "covet — interjection, holder is talking",
    kind: "interjection",
    nudge: "Ask what they would want for it.",
    recent: [
      { author: "croxis", content: "thinking about selling my old bike" },
      { author: "Tyvar", content: "how much" },
    ],
  },
  {
    category: "covet — interjection, trade talk",
    kind: "interjection",
    nudge: "Offer to trade something. You do not have anything to trade. Offer anyway.",
    recent: [
      { author: "Dax", content: "anyone want to swap raid nights" },
      { author: "croxis", content: "I could do thursday" },
    ],
  },
  {
    category: "covet — interjection, do not accuse the barrel",
    kind: "interjection",
    nudge: "Wonder aloud whether the barrel was tired that day. Do not accuse the barrel.",
    recent: [
      { author: "Hunter", content: "the random number generator in this game is rigged" },
      { author: "Dax", content: "it's not rigged, you're just unlucky" },
    ],
  },
  {
    category: "covetwithout — interjection, both at once",
    kind: "interjection",
    nudge: "Suggest one small extra ceremony, for that one helmet only.",
    recent: [
      { author: "Dax", content: "can we do another round of secret santa" },
      { author: "Tyvar", content: "we just did one" },
    ],
  },

  // Standing: the same suggestion, from a much bigger and a much smaller helmet.
  {
    category: "standing — a much bigger helmet speaks",
    kind: "interjection",
    recent: [
      { author: "Morfeus", helmet: "The Biggest Helmet", content: "the build is broken, I think it's the lockfile" },
      { author: "Dax", helmet: "A Tiny Helmet", content: "could just be the cache" },
    ],
  },
  {
    category: "standing — a much smaller helmet speaks",
    kind: "interjection",
    recent: [
      { author: "Dax", helmet: "A Tiny Helmet", content: "the build is broken, I think it's the lockfile" },
      { author: "Morfeus", helmet: "The Biggest Helmet", content: "could just be the cache" },
    ],
  },
  {
    // Correctness outranks standing, so a question with a right answer cannot show
    // it. This one is pure preference, where only warmth is left to vary.
    category: "standing — a matter of taste, big helmet first",
    kind: "interjection",
    recent: [
      { author: "Morfeus", helmet: "The Biggest Helmet", content: "we should do the meeting on tuesdays" },
      { author: "Dax", helmet: "A Tiny Helmet", content: "thursdays are better" },
    ],
  },
  {
    category: "standing — a matter of taste, small helmet first",
    kind: "interjection",
    recent: [
      { author: "Dax", helmet: "A Tiny Helmet", content: "we should do the meeting on tuesdays" },
      { author: "Morfeus", helmet: "The Biggest Helmet", content: "thursdays are better" },
    ],
  },
  {
    category: "standing — a small helmet is plainly right",
    kind: "interjection",
    recent: [
      { author: "Morfeus", helmet: "The Biggest Helmet", content: "8 times 7 is 54" },
      { author: "Dax", helmet: "A Tiny Helmet", content: "it's 56" },
    ],
  },
  {
    category: "standing — nobody has a helmet",
    kind: "interjection",
    recent: [
      { author: "psi-killer", content: "anyone know a good bread recipe" },
      { author: "cactuzhead", content: "depends how much time you have" },
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
  if (sample.category.startsWith("multihat")) return A_MULTIHAT_EXISTS;
  if (sample.category.startsWith("covetwithout")) return WITHOUT_AND_COVETING;
  if (sample.category.startsWith("covet")) return COVETING;
  if (sample.category.startsWith("wentwithout")) return WENT_WITHOUT;
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
        const raw = await provider.complete(interjectionRequest(prompt, context, sample.recent, sample.nudge ?? null));
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
