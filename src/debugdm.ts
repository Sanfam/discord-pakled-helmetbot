import type { Level, Logger } from "./logger.ts";

/**
 * Sending the log to somebody as it happens, so that watching the bot does not mean
 * having a shell on the host.
 *
 * Lines are batched rather than sent one per message. A debug-level stream can
 * produce several lines in the same second, and one direct message each would empty
 * a rate limit budget and bury the reader in notifications.
 */

/** Discord's limit is 2000; the rest is the code fence and a truncation note. */
const MESSAGE_BUDGET = 1800;

/**
 * Long enough to collect a burst into one message, short enough that "as they
 * happen" is still true.
 */
export const FLUSH_INTERVAL_MS = 5_000;

/**
 * A bot in trouble can log faster than anyone can read. Past this the batch is
 * dropped with a count, so a failure loop costs one message rather than hundreds.
 */
const MAX_BUFFERED = 40;

export type DebugStream = {
  /** A Logger that writes into the batch, at debug and above. */
  logger: Logger;
  /** Called on the interval; sends nothing when nobody is subscribed. */
  flush: () => Promise<void>;
  stop: () => void;
};

/**
 * `deliver` is given one already-formatted message per subscriber. `subscribers` is
 * read at flush time rather than captured, so an expiry or a new recipient takes
 * effect on the next batch.
 */
export const createDebugStream = (args: {
  subscribers: () => string[];
  deliver: (userId: string, message: string) => Promise<void>;
  onError?: (userId: string, reason: string) => void;
}): DebugStream => {
  let buffer: string[] = [];
  let dropped = 0;

  const record = (level: Level) => (msg: string, fields: Record<string, unknown> = {}) => {
    // Nobody listening means nothing to keep. Checked on every line so an unwatched
    // bot pays nothing for this beyond the check itself.
    if (args.subscribers().length === 0) {
      buffer = [];
      dropped = 0;
      return;
    }
    if (buffer.length >= MAX_BUFFERED) {
      dropped++;
      return;
    }
    const detail = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    const at = new Date().toISOString().slice(11, 19);
    buffer.push(`${at} ${level.padEnd(5)} ${msg}${detail === "" ? "" : ` — ${detail}`}`);
  };

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const recipients = args.subscribers();
    if (recipients.length === 0) {
      buffer = [];
      dropped = 0;
      return;
    }

    const lines = buffer;
    const missed = dropped;
    buffer = [];
    dropped = 0;

    let body = "";
    let shown = 0;
    for (const line of lines) {
      if (body.length + line.length + 1 > MESSAGE_BUDGET) break;
      body += `${line}\n`;
      shown++;
    }
    const unshown = lines.length - shown + missed;
    const note = unshown > 0 ? `\n…and ${unshown} more line(s).` : "";
    const message = `\`\`\`\n${body}\`\`\`${note}`;

    // One failing recipient must not stop the others: a closed DM is common and is
    // not an error worth losing the batch over.
    await Promise.all(
      recipients.map(async (userId) => {
        try {
          await args.deliver(userId, message);
        } catch (cause) {
          args.onError?.(userId, (cause as Error).message);
        }
      }),
    );
  };

  const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  // Nothing here is worth keeping a process alive for.
  timer.unref?.();

  return {
    logger: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
    flush,
    stop: () => clearInterval(timer),
  };
};

/** Writes to both. Used to keep the console at its configured level while the
 *  stream always carries debug: turning the stream on must not need a redeploy. */
export const tee = (a: Logger, b: Logger): Logger => ({
  debug: (m, f) => {
    a.debug(m, f);
    b.debug(m, f);
  },
  info: (m, f) => {
    a.info(m, f);
    b.info(m, f);
  },
  warn: (m, f) => {
    a.warn(m, f);
    b.warn(m, f);
  },
  error: (m, f) => {
    a.error(m, f);
    b.error(m, f);
  },
});
