export const LEVELS = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];

export type Logger = Record<Level, (msg: string, fields?: Record<string, unknown>) => void>;

/**
 * Structured JSON-line logging. Secrets are never passed in, so there is nothing
 * to redact: the token and API keys are read from the environment and handed
 * straight to their clients.
 */
export const createLogger = (min: Level, write = (line: string) => console.log(line)): Logger => {
  const threshold = LEVELS.indexOf(min);
  const at = (level: Level) => (msg: string, fields: Record<string, unknown> = {}) => {
    if (LEVELS.indexOf(level) < threshold) return;
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
};
