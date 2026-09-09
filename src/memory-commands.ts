import type { CommandHandlers } from "./commands.ts";
import type { Config } from "./config.ts";
import type { MemoryStore, MemoryAction } from "./memory-store.ts";
import { memoryEligible, type MemoryAccess } from "./memory.ts";

export const memoryCommands = (args: { guildId: string; config: Config; store: MemoryStore; access: MemoryAccess;
  mayInspect: (callerId: string) => Promise<boolean> }): CommandHandlers => {
  const { guildId, config, store } = args;
  const boundary = "Personal notes only: ceremony records remain. Deletion removes live application notes, not operator backups. Already-submitted Discord messages cannot be recalled.";
  return Object.fromEntries(["inspect", "forget", "clear", "disable", "enable", "scope"].map((kind) => [
    `memory ${kind}`, async ({ caller, targetUserId, memory }: Parameters<CommandHandlers[string]>[0]): Promise<string> => {
      const target = targetUserId ?? caller.userId;
      if (target !== caller.userId && (kind !== "inspect" || !await args.mayInspect(caller.userId))) return "You may only manage or inspect your own personal memory.";
      if (kind === "inspect") {
        const member = await args.access.member(target);
        if (!member) return "That member could not be verified in this server.";
        // Authority can change while Discord resolves a member.
        if (target !== caller.userId && !await args.mayInspect(caller.userId)) return "You may only inspect your own personal memory.";
        const control = store.memoryControl(guildId, target);
        const notes = store.memoryNotes(guildId, target, Date.now(), config.memory.retentionDays);
        const page = Math.max(1, Math.min(notes.length || 1, memory?.page ?? 1));
        const note = notes[page - 1];
        const scope = config.memory.scope === "channel" || control.scope === "channel" ? "channel" : "category";
        return [
          `Personal memory: server ${config.memory.enabled ? "enabled" : "disabled"}; member ${control.disabled ? "disabled" : "enabled"}; eligibility ${memoryEligible(config, member) ? "allowed" : "excluded"}.`,
          `Learning: ${config.memory.learning}; maximum recall scope: ${scope}; retention: ${config.memory.retentionDays} days.`,
          "Stores short ordinary-topic notes after delivered replies. Authorized Server Owner/Bot Admins can privately inspect these notes. Server activation is not individual consent; consent onboarding is deferred.",
          note ? `Note ${page}/${notes.length}: ${note.id}\nTopic: ${note.tag}\n${note.summary}\nSource: <#${note.source.channelId}>; category at capture: ${note.source.categoryId ?? "uncategorized"}\nHuman evidence: ${new Date(note.reaffirmedAt).toISOString()}\nExpires: ${new Date(note.expiresAt).toISOString()}` : "No unexpired notes.",
          "Use /helmet memory forget, clear, disable (optionally clear), enable, or scope. Clear does not disable future learning. Category sharing is limited to matching audience rules; thread notes stay in their source.",
          boundary,
        ].join("\n");
      }
      let action: MemoryAction;
      switch (kind) {
        case "forget":
          if (!memory?.note) return "Supply the note ID from /helmet memory inspect.";
          action = { kind, id: memory.note, wholeTopic: memory.wholeTopic }; break;
        case "scope":
          if (memory?.scope !== "channel" && memory?.scope !== "category") return "Scope must be channel or category.";
          action = { kind, scope: memory.scope }; break;
        case "disable": action = { kind, clear: memory?.clear ?? false }; break;
        case "clear": case "enable": action = { kind }; break;
        default: return "Unknown memory operation.";
      }
      const deleted = store.controlMemory(guildId, caller.userId, action, Date.now());
      const result = kind === "forget" ? `Deleted ${deleted} note(s) ${memory?.wholeTopic ? "for this exact topic tag across all sources" : "for this note ID only"}.` :
        kind === "clear" ? `Deleted ${deleted} notes. Your learning preference is unchanged.` :
        kind === "disable" ? `Memory disabled for you.${memory?.clear ? ` Deleted ${deleted} notes.` : " Existing notes still expire and can be inspected or cleared."}` :
        kind === "enable" ? "Memory re-enabled within server policy. Deleted notes are not restored." : "Scope preference saved; narrower server policy still applies.";
      return `${result}\n${boundary}`;
    },
  ]));
};
