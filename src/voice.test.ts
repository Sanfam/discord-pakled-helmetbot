import { describe, expect, it } from "vitest";
import { interjectionRequest, replyRequest, type PakledContext } from "./voice.ts";

const context: PakledContext = {
  ownHelmet: "A Modest Helmet",
  wentWithout: false,
  biggestHelmetHolder: "Ann",
  multihatHolder: null,
  coveted: null,
  helmetOrder: ["A Tiny Helmet", "A Modest Helmet", "The Biggest Helmet"],
  ownRank: 2,
  channel: "general",
};

describe("conversation request context", () => {
  it("labels bot turns, timestamps, replies, and mentioned people", () => {
    const request = interjectionRequest("prompt", context, [
      { author: "Pakled", content: "We need the thing.", isBot: true, timestamp: 1_700_000_000_000 },
      { author: "Dax", content: "I found it.", replyTo: "Pakled", mentions: ["Ann"], timestamp: 1_700_000_001_000 },
    ]);
    const content = request.messages[0]!.content;
    expect(content).toContain("Pakled [bot;");
    expect(content).toContain("reply to Pakled");
    expect(content).toContain("mentioned Ann");
    expect(content).toContain("2023-");
  });

  it("adds a narrow continuation contract when requested", () => {
    const request = interjectionRequest(
      "prompt",
      context,
      [{ author: "Dax", content: "That answers my question." }],
      null,
      true,
    );
    const content = request.messages[0]!.content;
    expect(content).toContain("continuation check");
    expect(content).toContain("relevant, unmentioned follow-up");
    expect(content).toContain("Decline laughter");
  });

  it("keeps requester relationships and mentioned ownership visible", () => {
    const request = replyRequest("prompt", context, [], "What does Ann have?", {
      name: "Dax",
      helmet: null,
      replyTo: "Pakled",
      mentionedPeople: [{ name: "Ann", helmet: "The Biggest Helmet" }],
    });
    const content = request.messages[0]!.content;
    expect(content).toContain("This message replies to Pakled");
    expect(content).toContain("Ann [The Biggest Helmet]");
  });
});

it("excludes unrelated personal notes from direct and optional provider input", () => {
  const memories = JSON.stringify([{ person: "Alice", topic: "printer", fact: "Alice bought a 3D printer." }]);
  const remembered = { ...context, memories };
  for (const question of ["hey, good morning", "Thanks Alice", "What is for dinner?"]) {
    const direct = replyRequest("prompt", remembered, [], question);
    expect(direct.messages[0]!.content).not.toContain("3D printer");
    const optional = interjectionRequest("prompt", remembered, [
      { author: "Alice", content: "My printer is fixed." }, { author: "Bob", content: question },
    ]);
    expect(optional.messages[0]!.content).not.toContain("Optional personal notes");
  }
  expect(replyRequest("prompt", remembered, [], "What can I make with my printer?").messages[0]!.content).toContain("3D printer");
});

it("omits malformed memory input and filters each note independently", async () => {
  const { relevantMemories } = await import("./voice.ts");
  expect(relevantMemories("not JSON", "printer")).toBe("");
  const memories = JSON.stringify([{ person: "Alice", topic: "printer", fact: "Owns a printer." },
    { person: "Bob", topic: "gardening", fact: "Grows tomatoes." }]);
  expect(relevantMemories(memories, "My printer broke")).toContain("Owns a printer");
  expect(relevantMemories(memories, "My printer broke")).not.toContain("tomatoes");
});
