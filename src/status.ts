import type { CeremonyRecord } from "./store.ts";
import type { Schedule } from "./schedule.ts";

/**
 * Formatting for the read-only commands. Pure, so the awkward cases — nothing has
 * ever run, everything is paused, the breaker has tripped — are testable without a
 * guild.
 *
 * Written in the bot's own register rather than as a status page: people will read
 * these in a chat channel, not a dashboard.
 */

export type StatusView = {
  schedule: Schedule;
  maxConsecutiveFailures: number;
  ceremoniesEnabled: boolean;
  lastCeremony: CeremonyRecord | undefined;
  holders: { helmetName: string; rank: number; memberLabel: string | null }[];
  llmModel: string | null;
  now: number;
};

export const relative = (from: number, to: number): string => {
  const ms = to - from;
  if (ms <= 0) return "any moment now";
  // Rounded up, never down: "in 0 minutes" is not a thing to say, and a unit should
  // not flip before it has actually been reached.
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  return `in ${Math.floor(hours / 24)} days`;
};

export const nextCeremonyLine = (view: StatusView): string => {
  const { schedule, maxConsecutiveFailures, ceremoniesEnabled, now } = view;
  if (!ceremoniesEnabled) return "The helmet plan is switched off. This is not my decision.";
  if (schedule.consecutiveFailures >= maxConsecutiveFailures) {
    return `The plan is broken. It failed ${schedule.consecutiveFailures} times. Someone must tell me to resume.`;
  }
  if (schedule.paused) return "The plan is stopped. The helmets stay where they are. For now.";
  if (schedule.nextCeremonyAt === null) return "There is no plan yet. There will be one.";
  return `The next helmet ceremony is ${relative(now, schedule.nextCeremonyAt)}.`;
};

export const holdersLines = (view: StatusView): string[] => {
  if (view.holders.length === 0) return ["Nobody has a helmet. This is wrong."];
  return [...view.holders]
    .sort((a, b) => b.rank - a.rank)
    .map((h) => `${h.helmetName} — ${h.memberLabel ?? "nobody"}`);
};

export const lastCeremonyLine = (view: StatusView): string => {
  const last = view.lastCeremony;
  if (last === undefined) return "There has not been a ceremony yet.";
  // An unfinished ceremony must not be reported as one that worked: status is read
  // most often precisely when one is slow or stuck.
  if (last.completedAt === null) return "A ceremony is happening now. Do not touch the helmets.";
  if (last.status === "FAILED") return "The last ceremony went wrong. I do not want to talk about it.";
  if (last.dryRun) return "The last ceremony was only pretend.";
  return "The last ceremony worked. I still do not think this is my helmet.";
};

export const statusReport = (view: StatusView): string =>
  [
    nextCeremonyLine(view),
    lastCeremonyLine(view),
    "",
    ...holdersLines(view),
    // Which model is behind it is a fact about the deployment, not about the
    // Pakled, and it has no way to say a model name that sounds like itself. Only
    // the notable state is worth remarking on: that it has no help today. Anyone
    // who needs the model name has the logs.
    ...(view.llmModel === null ? ["", "I am thinking with my own head today."] : []),
  ].join("\n");
