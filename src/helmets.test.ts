import { describe, expect, it } from "vitest";
import { applyReconciliation, reconcile, type GuildRole, type RolePort, type StoredHelmetRole } from "./helmets.ts";
import type { Helmet } from "./config.ts";

const helmet = (id: string, name: string, rank: number): Helmet => ({ id, name, rank, hoist: true });

const tiny = helmet("tiny", "A Tiny Helmet", 1);
const biggest = helmet("biggest", "The Biggest Helmet", 2);

const role = (id: string, name: string, extra: Partial<GuildRole> = {}): GuildRole =>
  ({ id, name, position: 5, color: "#000000", hoist: true, ...extra });
const stored = (helmetId: string, roleId: string): StoredHelmetRole => ({ helmetId, roleId });

describe("reconcile", () => {
  it("creates every helmet when nothing has been provisioned", () => {
    expect(reconcile([tiny, biggest], [], [])).toEqual([
      { kind: "create", helmet: tiny },
      { kind: "create", helmet: biggest },
    ]);
  });

  it("does nothing when provisioned roles already match", () => {
    const ops = reconcile(
      [tiny, biggest],
      [stored("tiny", "r1"), stored("biggest", "r2")],
      [role("r1", "A Tiny Helmet"), role("r2", "The Biggest Helmet")],
    );
    expect(ops).toEqual([]);
  });

  it("updates rather than recreating when a helmet's name changes", () => {
    const renamed = helmet("tiny", "A Very Tiny Helmet", 1);
    const ops = reconcile([renamed], [stored("tiny", "r1")], [role("r1", "A Tiny Helmet")]);
    expect(ops).toEqual([
      { kind: "update", helmetId: "tiny", roleId: "r1", helmet: renamed, changed: ['name "A Tiny Helmet" -> "A Very Tiny Helmet"'] },
    ]);
  });

  it("applies a colour change from config", () => {
    const recoloured: Helmet = { ...tiny, color: "#ffc400" };
    const ops = reconcile([recoloured], [stored("tiny", "r1")], [role("r1", "A Tiny Helmet", { color: "#8a8a8a" })]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "update", changed: ["colour #8a8a8a -> #ffc400"] });
  });

  it("applies a hoist change from config", () => {
    const unhoisted: Helmet = { ...tiny, hoist: false };
    const ops = reconcile([unhoisted], [stored("tiny", "r1")], [role("r1", "A Tiny Helmet")]);
    expect(ops[0]).toMatchObject({ kind: "update", changed: ["hoist true -> false"] });
  });

  it("leaves colour alone when config does not specify one", () => {
    const ops = reconcile([tiny], [stored("tiny", "r1")], [role("r1", "A Tiny Helmet", { color: "#123456" })]);
    expect(ops).toEqual([]);
  });

  it("deletes a provisioned role whose helmet has left the config", () => {
    const ops = reconcile(
      [tiny],
      [stored("tiny", "r1"), stored("biggest", "r2")],
      [role("r1", "A Tiny Helmet"), role("r2", "The Biggest Helmet")],
    );
    expect(ops).toEqual([{ kind: "delete", helmetId: "biggest", roleId: "r2", name: "The Biggest Helmet" }]);
  });

  it("never touches a role that merely shares a helmet's name", () => {
    const ops = reconcile([tiny], [], [role("impostor", "A Tiny Helmet")]);
    expect(ops).toEqual([{ kind: "create", helmet: tiny }]);
  });

  it("does not delete a role it never provisioned, even when the helmet leaves the config", () => {
    const ops = reconcile([], [], [role("impostor", "A Tiny Helmet")]);
    expect(ops).toEqual([]);
  });

  it("forgets a stored record whose helmet left the config and whose role is already gone", () => {
    expect(reconcile([], [stored("biggest", "gone")], [])).toEqual([
      { kind: "forget", helmetId: "biggest", roleId: "gone" },
    ]);
  });

  it("recreates a provisioned role that has been deleted from the guild by hand", () => {
    expect(reconcile([tiny], [stored("tiny", "gone")], [])).toEqual([
      { kind: "create", helmet: tiny, replacingRoleId: "gone" },
    ]);
  });

  it("ignores Discord role position entirely: rank comes from config", () => {
    const ops = reconcile(
      [tiny, biggest],
      [stored("tiny", "r1"), stored("biggest", "r2")],
      [role("r1", "A Tiny Helmet", { position: 99 }), role("r2", "The Biggest Helmet", { position: 1 })],
    );
    expect(ops).toEqual([]);
  });

  it("deletes before creating, so a rename-by-id never collides", () => {
    const ops = reconcile([biggest], [stored("tiny", "r1")], [role("r1", "A Tiny Helmet")]);
    expect(ops[0]).toMatchObject({ kind: "delete" });
    expect(ops[1]).toMatchObject({ kind: "create" });
  });
});

const fakePort = () => {
  const calls: string[] = [];
  let next = 0;
  const port: RolePort = {
    create: async (h) => {
      calls.push(`create:${h.name}`);
      return `new-${++next}`;
    },
    update: async (roleId, helmet) => void calls.push(`update:${roleId}:${helmet.name}`),
    delete: async (roleId) => void calls.push(`delete:${roleId}`),
  };
  return { port, calls };
};

const fakeStore = () => {
  const records = new Map<string, string>();
  return {
    records,
    store: {
      record: (helmetId: string, roleId: string) => void records.set(helmetId, roleId),
      forget: (helmetId: string) => void records.delete(helmetId),
    },
  };
};

describe("applyReconciliation", () => {
  it("records the role id of every helmet it creates", async () => {
    const { port } = fakePort();
    const { store, records } = fakeStore();
    await applyReconciliation(reconcile([tiny, biggest], [], []), port, store);
    expect(records.get("tiny")).toBe("new-2");
    expect(records.get("biggest")).toBe("new-1");
  });

  it("creates in descending rank so hoisted helmets read biggest first", async () => {
    const { port, calls } = fakePort();
    const { store } = fakeStore();
    await applyReconciliation(reconcile([tiny, biggest], [], []), port, store);
    expect(calls).toEqual(["create:The Biggest Helmet", "create:A Tiny Helmet"]);
  });

  it("removes before creating, and forgets the record it deleted", async () => {
    const { port, calls } = fakePort();
    const { store, records } = fakeStore();
    records.set("tiny", "r1");
    await applyReconciliation(
      reconcile([biggest], [stored("tiny", "r1")], [role("r1", "A Tiny Helmet")]),
      port,
      store,
    );
    expect(calls).toEqual(["delete:r1", "create:The Biggest Helmet"]);
    expect(records.has("tiny")).toBe(false);
  });

  it("forgets a stale record without calling Discord", async () => {
    const { port, calls } = fakePort();
    const { store, records } = fakeStore();
    records.set("biggest", "gone");
    await applyReconciliation(reconcile([], [stored("biggest", "gone")], []), port, store);
    expect(calls).toEqual([]);
    expect(records.has("biggest")).toBe(false);
  });
});
