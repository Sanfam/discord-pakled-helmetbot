import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "./store.ts";

describe("store", () => {
  let store: Store;
  beforeEach(() => void (store = openStore(":memory:")));
  afterEach(() => store.close());

  it("starts with nothing provisioned", () => {
    expect(store.helmetRoles("g1")).toEqual([]);
  });

  it("round-trips a provisioned helmet role", () => {
    store.recordHelmetRole("g1", "biggest", "r9");
    expect(store.helmetRoles("g1")).toEqual([{ helmetId: "biggest", roleId: "r9" }]);
  });

  it("keeps guilds separate", () => {
    store.recordHelmetRole("g1", "biggest", "r9");
    store.recordHelmetRole("g2", "biggest", "r7");
    expect(store.helmetRoles("g1")).toEqual([{ helmetId: "biggest", roleId: "r9" }]);
    expect(store.helmetRoles("g2")).toEqual([{ helmetId: "biggest", roleId: "r7" }]);
  });

  it("replaces the role id when a helmet is re-provisioned", () => {
    store.recordHelmetRole("g1", "biggest", "old");
    store.recordHelmetRole("g1", "biggest", "new");
    expect(store.helmetRoles("g1")).toEqual([{ helmetId: "biggest", roleId: "new" }]);
  });

  it("forgets a record without touching other guilds", () => {
    store.recordHelmetRole("g1", "biggest", "r9");
    store.recordHelmetRole("g2", "biggest", "r7");
    store.forgetHelmetRole("g1", "biggest");
    expect(store.helmetRoles("g1")).toEqual([]);
    expect(store.helmetRoles("g2")).toHaveLength(1);
  });
});
