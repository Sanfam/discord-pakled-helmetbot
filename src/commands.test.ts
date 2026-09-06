import { describe, expect, it } from "vitest";
import { mayRun, parseDuration, type Caller } from "./commands.ts";

const nobody: Caller = { userId: "u1", isOwner: false, isAdmin: false };
const admin: Caller = { userId: "u2", isOwner: false, isAdmin: true };
const owner: Caller = { userId: "u3", isOwner: true, isAdmin: false };

describe("mayRun", () => {
  it("lets anyone watch", () => {
    for (const key of ["status", "roles"]) {
      expect(mayRun(key, nobody)).toBe(true);
    }
  });

  it("keeps steering away from everyone else", () => {
    for (const key of ["next", "pause", "resume", "ceremony", "debug-dm enable"]) {
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
