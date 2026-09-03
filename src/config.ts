import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { LEVELS } from "./logger.ts";

/**
 * Configuration is read-only input describing behaviour. Identity and secrets come
 * from the environment instead. The bot never writes to config.yaml: the database
 * is the only writer of state.
 *
 * Sections are added by the ticket that first needs them, rather than declared up
 * front. Unknown keys are ignored, so a config file may run ahead of the code.
 */
const helmet = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rank: z.number().int().positive(),
  // Validated here so the rest of the app can rely on the shape Discord wants.
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "must be a hex colour such as #ffc400")
    .transform((c) => c as `#${string}`)
    .optional(),
  hoist: z.boolean().default(true),
});

const configSchema = z.object({
  enabled: z.boolean().default(true),
  logging: z.object({ level: z.enum(LEVELS).default("info") }).default({}),
  helmets: z.array(helmet).min(1),
  channels: z
    .object({
      /** Where ceremony failures are reported. Never selected for conversation. */
      adminChannelId: z.string().nullable().default(null),
      deny: z.array(z.string()).default([]),
    })
    .default({}),
  llm: z
    .object({
      provider: z.literal("openrouter").default("openrouter"),
      /** Never referenced in logic — swapping models is a config change. */
      model: z.string().default("deepseek/deepseek-v4-flash"),
      promptPath: z.string().default("prompts/pakled-conversation.md"),
      /** Global ceiling on request rate, whatever else is happening. */
      minRequestIntervalMs: z.number().int().nonnegative().default(1500),
    })
    .default({}),
  participants: z
    .object({
      excludedUserIds: z.array(z.string()).default([]),
      excludedRoleIds: z.array(z.string()).default([]),
    })
    .default({}),
  development: z.object({ dryRun: z.boolean().default(false) }).default({}),
});

export type Config = z.infer<typeof configSchema>;
export type Helmet = z.infer<typeof helmet>;

export type Environment = {
  discordToken: string;
  discordGuildId: string;
  /**
   * Optional. Without it the bot still provisions helmets and runs Ceremonies,
   * speaking in static fallback lines: losing the character is much better than
   * losing the bot.
   */
  openrouterApiKey: string | null;
  dataDir: string;
};

export class ConfigError extends Error {}

const required = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`${key} is not set. Copy .env.example to .env and populate it.`);
  return value;
};

export const loadEnvironment = (env: NodeJS.ProcessEnv = process.env): Environment => ({
  discordToken: required(env, "DISCORD_TOKEN"),
  discordGuildId: required(env, "DISCORD_GUILD_ID"),
  openrouterApiKey: env.OPENROUTER_API_KEY?.trim() || null,
  dataDir: env.PAKLED_DATA_DIR?.trim() || "./data",
});

export const parseConfig = (source: string): Config => {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (cause) {
    throw new ConfigError(`config.yaml is not valid YAML: ${(cause as Error).message}`);
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`config.yaml is invalid:\n${problems.join("\n")}`);
  }

  const config = result.data;
  const ranks = new Set(config.helmets.map((h) => h.rank));
  if (ranks.size !== config.helmets.length) throw new ConfigError("config.yaml is invalid:\n  helmets: ranks must be unique");
  const ids = new Set(config.helmets.map((h) => h.id));
  if (ids.size !== config.helmets.length) throw new ConfigError("config.yaml is invalid:\n  helmets: ids must be unique");

  return config;
};

export const loadConfig = (dataDir: string): Config => {
  const path = join(dataDir, "config.yaml");
  try {
    return parseConfig(readFileSync(path, "utf8"));
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(`Could not read ${path}: ${(cause as Error).message}`);
  }
};
