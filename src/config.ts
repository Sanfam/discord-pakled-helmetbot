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
      /** Where Ceremonies are performed. Unset, the busiest allowed channel is used. */
      ceremonyChannelId: z.string().nullable().default(null),
      deny: z.array(z.string()).default([]),
    })
    .default({}),
  ceremony: z
    .object({
      enabled: z.boolean().default(true),
      // Bounded, not merely positive: an unbounded interval overflows the random
      // source and can produce a timestamp Date cannot render.
      minIntervalHours: z.number().positive().max(8760).default(72),
      maxIntervalHours: z.number().positive().max(8760).default(336),
      retryMinMinutes: z.number().positive().max(10080).default(15),
      retryMaxMinutes: z.number().positive().max(10080).default(60),
      maxConsecutiveFailures: z.number().int().positive().default(3),
      /** How often the daemon looks at the clock. */
      checkIntervalSeconds: z.number().int().positive().default(60),
      /**
       * The Ceremony as theatre. Spread over minutes so the member list changes
       * while the Pakled is still talking, rather than all at once in silence.
       */
      narration: z
        .object({
          enabled: z.boolean().default(true),
          minSpanMinutes: z.number().int().nonnegative().max(120).default(5),
          maxSpanMinutes: z.number().int().nonnegative().max(120).default(15),
        })
        .refine((n) => n.maxSpanMinutes >= n.minSpanMinutes, {
          message: "maxSpanMinutes must be at least minSpanMinutes",
        })
        .default({}),
    })
    .refine((c) => c.maxIntervalHours >= c.minIntervalHours, {
      message: "maxIntervalHours must be at least minIntervalHours",
    })
    .refine((c) => c.retryMaxMinutes >= c.retryMinMinutes, {
      message: "retryMaxMinutes must be at least retryMinMinutes",
    })
    .default({}),
  conversation: z
    .object({
      mentionEnabled: z.boolean().default(true),
      // 99, not 100: Discord's own fetch limit is 100 and one of those is the
      // message that triggered us.
      mentionContextMessages: z.number().int().positive().max(99).default(20),
      /** Per person, so one user cannot monopolise the bot. */
      mentionCooldownSeconds: z.number().int().nonnegative().default(30),
      /** A per-user cooldown does nothing against a crowd, and every answer is paid for. */
      channelCooldownSeconds: z.number().int().nonnegative().default(5),
      /** Hard ceiling on mentions being answered at once, whatever the crowd does. */
      maxConcurrentMentions: z.number().int().positive().max(20).default(3),
      passive: z
        .object({
          enabled: z.boolean().default(true),
          // Whole minutes: a fractional bound reaches crypto.randomInt and throws.
          minIntervalMinutes: z.number().int().positive().max(10080).default(45),
          maxIntervalMinutes: z.number().int().positive().max(10080).default(180),
          /** Chance of even asking the model, once the cheap gates have passed. */
          probability: z.number().min(0).max(1).default(0.5),
          /** How long to leave a channel alone after speaking in it. */
          channelCooldownMinutes: z.number().int().nonnegative().max(10080).default(90),
          activityFloor: z
            .object({
              windowMinutes: z.number().int().positive().max(1440).default(30),
              minMessages: z.number().int().positive().default(5),
              minDistinctAuthors: z.number().int().positive().default(2),
            })
            .default({}),
        })
        .refine((p) => p.maxIntervalMinutes >= p.minIntervalMinutes, {
          message: "maxIntervalMinutes must be at least minIntervalMinutes",
        })
        .default({}),
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
      /**
       * Prefer people who have been around recently, so a dormant member does not
       * anchor a helmet for a fortnight without noticing. Weighted, never filtered:
       * nobody is permanently excluded, and an occasional surprise helmet for
       * someone who has been away is good for the bit.
       */
      activityWeighting: z
        .object({
          enabled: z.boolean().default(true),
          tiers: z
            .array(z.object({ withinDays: z.number().finite().positive(), weight: z.number().finite().positive() }))
            .default([
              { withinDays: 7, weight: 8 },
              { withinDays: 30, weight: 3 },
            ]),
          dormantWeight: z.number().finite().positive().default(1),
        })
        .default({}),
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
