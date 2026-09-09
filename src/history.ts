export type RecordedAssignment = {
  ceremonyId: string;
  completedAt: number;
  memberId: string | null;
};

export type HelmetHistory = {
  currentHolderId: string | null;
  previousHolderId: string | null;
  assignments: number;
  runStartedAt: number | null;
  runDurationMs: number | null;
  repeated: boolean;
  coverageStartedAt: number | null;
};

export function helmetHistory(
  rows: Iterable<RecordedAssignment>,
  memberId: string,
  now: number,
): HelmetHistory {
  let currentHolderId: string | null = null;
  let previousHolderId: string | null = null;
  let assignments = 0;
  let runStartedAt: number | null = null;
  let repeated = false;
  let coverageStartedAt: number | null = null;

  for (const row of rows) {
    coverageStartedAt ??= row.completedAt;
    if (row.memberId === memberId) assignments++;

    if (row.memberId === null) {
      currentHolderId = null;
      previousHolderId = null;
      runStartedAt = null;
      repeated = false;
      continue;
    }

    repeated = currentHolderId === row.memberId;
    if (!repeated) {
      previousHolderId = currentHolderId;
      runStartedAt = row.completedAt;
    }
    currentHolderId = row.memberId;
  }

  const runDurationMs = runStartedAt === null || now < runStartedAt ? null : now - runStartedAt;
  return {
    currentHolderId,
    previousHolderId,
    assignments,
    runStartedAt,
    runDurationMs,
    repeated,
    coverageStartedAt,
  };
}

const recordedAt = (at: number): string => new Date(at).toISOString();
const plural = (count: number, singular: string): string => `${count} ${singular}${count === 1 ? "" : "s"}`;

export function historicalFacts(
  history: HelmetHistory,
  memberName: string | null,
  currentHolderName: string | null,
  previousHolderName: string | null,
): string {
  const facts = [
    history.coverageStartedAt === null
      ? "No helmet history is recorded."
      : `Available helmet history is recorded from ${recordedAt(history.coverageStartedAt)}.`,
    `${memberName ?? "The requested member"} has ${plural(history.assignments, "recorded assignment")}.`,
    history.currentHolderId === null
      ? "No current holder is recorded in the available history."
      : `The current recorded holder is ${currentHolderName ?? "unnamed"}.`,
    history.previousHolderId === null
      ? "No previous holder is recorded in the current continuity."
      : `The previous recorded holder is ${previousHolderName ?? "unnamed"}.`,
  ];

  if (history.runStartedAt !== null && history.runDurationMs !== null) {
    facts.push(
      `The current recorded assignment run began at ${recordedAt(history.runStartedAt)} and has lasted ${history.runDurationMs} ms. This does not establish uninterrupted Discord role possession.`,
    );
  }
  if (history.repeated) facts.push("The latest two recorded ceremonies repeat the current holder.");
  return facts.join(" ");
}
