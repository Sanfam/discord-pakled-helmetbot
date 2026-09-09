import { describe, expect, it } from "vitest";
import { mayRun, privateCommand, parseDuration, type Caller } from "./commands.ts";

const nobody: Caller = { userId: "u1", isOwner: false, isAdmin: false };
const admin: Caller = { userId: "u2", isOwner: false, isAdmin: true };
const owner: Caller = { userId: "u3", isOwner: true, isAdmin: false };

describe("mayRun", () => {
  it("lets anyone watch", () => {
    for (const key of ["helmets where", "roles"]) {
      expect(mayRun(key, nobody)).toBe(true);
    }
  });

  it("keeps steering away from everyone else", () => {
    for (const key of ["status", "next", "pause", "resume", "ceremony", "debug-dm enable"]) {
      expect(mayRun(key, nobody)).toBe(false);
      expect(mayRun(key, admin)).toBe(true);
      expect(mayRun(key, owner)).toBe(true);
    }
  });

  it("keeps appointing admins to the owner alone", () => {
    // An admin who can appoint admins is an admin forever, whatever the owner
    // later decides.
    for (const key of ["admin add", "admin remove"]) {
      expect(mayRun(key, admin)).toBe(false);
      expect(mayRun(key, owner)).toBe(true);
      expect(mayRun(key, nobody)).toBe(false);
    }
  });

  it("refuses anything it has never heard of", () => {
    expect(mayRun("drop-tables", nobody)).toBe(false);
  });
});

describe("parseDuration", () => {
  it("reads every unit it offers", () => {
    expect(parseDuration("90m")).toBe(90 * 60_000);
    expect(parseDuration("2h")).toBe(2 * 3_600_000);
    expect(parseDuration("3d")).toBe(3 * 86_400_000);
    expect(parseDuration("1y")).toBe(31_536_000_000);
  });

  it("is forgiving about how it is written", () => {
    expect(parseDuration(" 2 Hours ")).toBe(2 * 3_600_000);
    expect(parseDuration("1 day")).toBe(86_400_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
  });

  it("refuses what it cannot read rather than guessing", () => {
    // A typo that silently became a year of direct messages would be a poor
    // surprise.
    for (const bad of ["", "soon", "2", "h", "-1d", "0h", "2 fortnights", "2d3h"]) {
      expect(parseDuration(bad)).toBeNull();
    }
  });

  it("refuses longer than a year", () => {
    expect(parseDuration("2y")).toBeNull();
    expect(parseDuration("400d")).toBeNull();
  });
});

it("keeps diagnostics private and holder lookup public", () => {
  expect(privateCommand("status")).toBe(true);
  expect(privateCommand("helmets where")).toBe(false);
});

it("routes plural holder lookup publicly and blocks public diagnostic delivery", async () => {
  const { handleCommands } = await import("./commands.ts");
  const { MessageFlags } = await import("discord.js");
  let listener: (interaction: unknown) => void = () => {};
  let resolve!: () => void;
  let finished = new Promise<void>((r) => { resolve = r; });
  const sent: { kind: string; value: unknown }[] = [];
  let diagnosticCalls = 0;
  const client = { on: (_event: unknown, fn: typeof listener) => { listener = fn; } };
  handleCommands(client as never, "g", { status: () => { diagnosticCalls++; return "private date"; }, "helmets where": () => "Alice has Big" }, () => false);
  const command = (commandName: string, sub: string, owner = false) => ({
    isChatInputCommand: () => true, commandName, guildId: "g", guild: { ownerId: owner ? "u" : "owner" }, user: { id: "u" },
    options: { getSubcommand: () => sub, getSubcommandGroup: () => null, getUser: () => null, getInteger: () => null, getString: () => null },
    reply: async (value: unknown) => { sent.push({ kind: "reply", value }); resolve(); },
    deferReply: async (value: unknown) => { sent.push({ kind: "defer", value }); },
    editReply: async (value: unknown) => { sent.push({ kind: "edit", value }); resolve(); },
  });
  listener(command("helmet", "status")); await finished;
  expect(diagnosticCalls).toBe(0);
  expect(sent[0]?.value).toMatchObject({ flags: MessageFlags.Ephemeral });
  sent.length = 0; finished = new Promise<void>((r) => { resolve = r; });
  listener(command("helmet", "status", true)); await finished;
  expect(diagnosticCalls).toBe(1);
  expect(sent[0]).toEqual({ kind: "defer", value: { flags: MessageFlags.Ephemeral } });
  sent.length = 0; finished = new Promise<void>((r) => { resolve = r; });
  listener(command("helmets", "where")); await finished;
  expect(sent[0]).toEqual({ kind: "defer", value: {} });
  expect(sent[1]?.value).toMatchObject({ content: "Alice has Big", allowedMentions: { parse: [] } });
});

it("does not execute status or retry publicly when private deferral fails", async () => {
  const { handleCommands } = await import("./commands.ts");
  let listener: (interaction: unknown) => void = () => {};
  let done!: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  let calls = 0;
  handleCommands({ on: (_event: unknown, fn: typeof listener) => { listener = fn; } } as never, "g",
    { status: () => { calls++; return "private date"; } }, () => true, () => done());
  listener({ isChatInputCommand: () => true, commandName: "helmet", guildId: "g", guild: { ownerId: "owner" }, user: { id: "u" },
    options: { getSubcommand: () => "status", getSubcommandGroup: () => null },
    deferReply: async () => { throw new Error("private delivery unavailable"); },
    reply: async () => { calls++; }, editReply: async () => { calls++; },
  });
  await finished;
  expect(calls).toBe(0);
});
