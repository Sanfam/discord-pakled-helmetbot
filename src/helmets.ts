import type { Helmet } from "./config.ts";

/**
 * Reconciliation of the configured Helmet Set against what has actually been
 * provisioned. Pure over its inputs so it can be tested without a guild.
 *
 * The rule that matters: only roles this bot provisioned and recorded are ever
 * renamed or deleted. A role that merely shares a helmet's name is somebody
 * else's and is left alone (ADR-0003, and the safety rule in specification §33).
 */

export type GuildRole = { id: string; name: string; position: number; color: string; hoist: boolean };
export type StoredHelmetRole = { helmetId: string; roleId: string };

export type ReconcileOp =
  /** `replacingRoleId` is set when the previously provisioned role has vanished from the guild. */
  | { kind: "create"; helmet: Helmet; replacingRoleId?: string }
  | { kind: "update"; helmetId: string; roleId: string; helmet: Helmet; changed: string[] }
  | { kind: "delete"; helmetId: string; roleId: string; name: string }
  /** Drop a stored record whose role is already gone and whose helmet has left the config. */
  | { kind: "forget"; helmetId: string; roleId: string };

export const reconcile = (
  helmets: Helmet[],
  stored: StoredHelmetRole[],
  guildRoles: GuildRole[],
): ReconcileOp[] => {
  const storedByHelmet = new Map(stored.map((s) => [s.helmetId, s.roleId]));
  const roleById = new Map(guildRoles.map((r) => [r.id, r]));
  const configured = new Set(helmets.map((h) => h.id));
  const ops: ReconcileOp[] = [];

  // Removals first, so a helmet id can be retired and reused in the same pass.
  for (const { helmetId, roleId } of stored) {
    if (configured.has(helmetId)) continue;
    const role = roleById.get(roleId);
    ops.push(role ? { kind: "delete", helmetId, roleId, name: role.name } : { kind: "forget", helmetId, roleId });
  }

  for (const helmet of helmets) {
    const roleId = storedByHelmet.get(helmet.id);
    const role = roleId === undefined ? undefined : roleById.get(roleId);

    if (role === undefined) {
      ops.push(roleId === undefined ? { kind: "create", helmet } : { kind: "create", helmet, replacingRoleId: roleId });
    } else {
      const changed = describeDifferences(role, helmet);
      if (changed.length > 0) ops.push({ kind: "update", helmetId: helmet.id, roleId: role.id, helmet, changed });
    }
  }

  return ops;
};

/** Config is authoritative over every property of a helmet role, not just its name. */
const describeDifferences = (role: GuildRole, helmet: Helmet): string[] => {
  const changed: string[] = [];
  if (role.name !== helmet.name) changed.push(`name "${role.name}" -> "${helmet.name}"`);
  if (helmet.color !== undefined && role.color.toLowerCase() !== helmet.color.toLowerCase()) {
    changed.push(`colour ${role.color} -> ${helmet.color}`);
  }
  if (role.hoist !== helmet.hoist) changed.push(`hoist ${role.hoist} -> ${helmet.hoist}`);
  return changed;
};

export const describeOp = (op: ReconcileOp): string => {
  switch (op.kind) {
    case "create":
      return `create "${op.helmet.name}"${op.replacingRoleId === undefined ? "" : " (previous role was deleted by hand)"}`;
    case "update":
      return `update "${op.helmet.name}" (${op.changed.join(", ")})`;
    case "delete":
      return `delete "${op.name}"`;
    case "forget":
      return `forget stale record for "${op.helmetId}"`;
  }
};

/** What applying a reconciliation needs from Discord. Implemented by the adapter. */
export type RolePort = {
  create(helmet: Helmet): Promise<string>;
  update(roleId: string, helmet: Helmet): Promise<void>;
  delete(roleId: string): Promise<void>;
};

export type HelmetRoleStore = {
  record(helmetId: string, roleId: string): void;
  forget(helmetId: string): void;
};

export const applyReconciliation = async (
  ops: ReconcileOp[],
  port: RolePort,
  store: HelmetRoleStore,
): Promise<void> => {
  // Discord creates each new role at the bottom of the list, so creating in
  // descending rank leaves hoisted helmets reading biggest-to-smallest.
  // Removals and updates run first, freeing names before anything is created.
  //
  // ponytail: display order is only correct for a full provisioning pass. A helmet
  // added to an existing Helmet Set lands at the bottom and stays there. Reposition
  // roles explicitly if display order is ever load-bearing; rank never comes from
  // Discord position, so nothing but appearance depends on this.
  const creates = ops
    .filter((op) => op.kind === "create")
    .sort((a, b) => b.helmet.rank - a.helmet.rank);
  const ordered = [...ops.filter((op) => op.kind !== "create"), ...creates];

  for (const op of ordered) {
    switch (op.kind) {
      case "create":
        store.record(op.helmet.id, await port.create(op.helmet));
        break;
      case "update":
        await port.update(op.roleId, op.helmet);
        break;
      case "delete":
        await port.delete(op.roleId);
        store.forget(op.helmetId);
        break;
      case "forget":
        store.forget(op.helmetId);
        break;
    }
  }
};
