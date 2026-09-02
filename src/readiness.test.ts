import { describe, expect, it } from "vitest";
import { checkReadiness, type GuildSnapshot } from "./readiness.ts";
import { parseConfig, ConfigError } from "./config.ts";
import type { Helmet } from "./config.ts";

const helmets: Helmet[] = [
  { id: "tiny", name: "A Tiny Helmet", rank: 1, hoist: true },
  { id: "biggest", name: "The Biggest Helmet", rank: 2, hoist: true },
];

const snapshot = (overrides: Partial<GuildSnapshot> = {}): GuildSnapshot => ({
  guildName: "Pakled Planet",
  memberCount: 30,
  botHighestRolePosition: 10,
  missingPermissions: [],
  helmetNamedRoles: [],
  intentsAccepted: true,
  ...overrides,
});

describe("checkReadiness", () => {
  it("passes on a correctly configured guild", () => {
    expect(checkReadiness(snapshot(), helmets).ok).toBe(true);
  });

  it("fails and names the permissions that are missing", () => {
    const report = checkReadiness(snapshot({ missingPermissions: ["Manage Roles"] }), helmets);
    expect(report.ok).toBe(false);
    expect(report.problems.join()).toContain("Manage Roles");
  });

  it("fails when a helmet role sits above the bot's own role", () => {
    const report = checkReadiness(
      snapshot({ botHighestRolePosition: 3, helmetNamedRoles: [{ name: "The Biggest Helmet", position: 5 }] }),
      helmets,
    );
    expect(report.ok).toBe(false);
    expect(report.problems.join()).toContain("The Biggest Helmet");
  });

  it("passes when helmet roles sit below the bot's own role", () => {
    const report = checkReadiness(
      snapshot({ botHighestRolePosition: 9, helmetNamedRoles: [{ name: "The Biggest Helmet", position: 5 }] }),
      helmets,
    );
    expect(report.ok).toBe(true);
  });

  it("confirms permissions, intents and hierarchy when all are in order", () => {
    const notes = checkReadiness(snapshot(), helmets).notes.join("\n");
    expect(notes).toContain("Permissions:");
    expect(notes).toContain("Privileged intents:");
    expect(notes).toContain("Role hierarchy:");
  });

  it("fails when there is no room beneath the bot's role", () => {
    expect(checkReadiness(snapshot({ botHighestRolePosition: 0 }), helmets).ok).toBe(false);
  });
});

describe("parseConfig", () => {
  const valid = `
helmets:
  - id: tiny
    name: A Tiny Helmet
    rank: 1
  - id: biggest
    name: The Biggest Helmet
    rank: 2
`;

  it("accepts a valid config and defaults the log level", () => {
    expect(parseConfig(valid).logging.level).toBe("info");
  });

  it("names the offending field when a helmet is malformed", () => {
    expect(() => parseConfig("helmets:\n  - id: tiny\n    rank: 1\n")).toThrow(/helmets\.0\.name/);
  });

  it("rejects duplicate ranks", () => {
    const dupe = valid.replace("rank: 2", "rank: 1");
    expect(() => parseConfig(dupe)).toThrow(/ranks must be unique/);
  });

  it("rejects a config with no helmets", () => {
    expect(() => parseConfig("helmets: []")).toThrow(ConfigError);
  });

  it("ignores keys it does not know about yet", () => {
    expect(() => parseConfig(`${valid}\nceremony:\n  minIntervalHours: 72\n`)).not.toThrow();
  });
});
