import {
  Events,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";

/**
 * The command surface, and who may use each part of it.
 *
 * Three tiers, checked per subcommand rather than on the whole command so that the
 * open ones never become restricted by inheritance:
 *
 * - **Anyone** may ask what the helmets are doing. Watching costs nothing.
 * - **A Bot Admin** may steer it — the schedule, the Ceremonies, the log stream.
 * - **The server owner alone** may appoint and dismiss Bot Admins. Delegating the
 *   power to delegate turns one appointment into a permanent one.
 */
const definition = new SlashCommandBuilder()
  .setName("helmet")
  .setDescription("The Great Helmet Barrel")
  .addSubcommand((s) => s.setName("status").setDescription("What is happening with the helmets"))
  .addSubcommand((s) => s.setName("roles").setDescription("Who has which helmet"))
  .addSubcommand((s) => s.setName("next").setDescription("When is the next Helmet Ceremony"))
  .addSubcommand((s) => s.setName("pause").setDescription("Stop the helmet plan"))
  .addSubcommand((s) => s.setName("resume").setDescription("Start the helmet plan again"))
  .addSubcommand((s) => s.setName("ceremony").setDescription("Hold a Helmet Ceremony now"))
  .addSubcommandGroup((g) =>
    g
      .setName("admin")
      .setDescription("Who tells me what to do")
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("Let someone tell me what to do")
          .addUserOption((o) => o.setName("user").setDescription("Who to trust").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Stop someone telling me what to do")
          .addUserOption((o) => o.setName("user").setDescription("Who to stop trusting").setRequired(true)),
      )
      .addSubcommand((s) => s.setName("list").setDescription("Who tells me what to do")),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("debug-dm")
      .setDescription("Tell someone what I am doing, while I do it")
      .addSubcommand((s) =>
        s
          .setName("enable")
          .setDescription("Start telling them")
          .addUserOption((o) => o.setName("recipient").setDescription("Who I tell (default: you)"))
          .addStringOption((o) =>
            o.setName("expiration").setDescription("How long, e.g. 90m, 2h, 3d, 1y (default: 1h)"),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName("disable")
          .setDescription("Stop telling them")
          .addUserOption((o) => o.setName("recipient").setDescription("Who I stop telling (default: you)")),
      )
      .addSubcommand((s) => s.setName("status").setDescription("Who I am telling")),
  )
  .toJSON();

/** Watching is free. Everything else is steering. */
const OPEN_TO_ALL = new Set(["status", "roles"]);
/** Appointing admins is the owner's alone: an admin who can appoint is permanent. */
const OWNER_ONLY = new Set(["admin add", "admin remove"]);

export type Caller = { userId: string; isOwner: boolean; isAdmin: boolean };

/**
 * Who may run what. The owner can do everything, including anything they have
 * delegated — they cannot lock themselves out by appointing others.
 */
export const mayRun = (key: string, caller: Caller): boolean => {
  if (OPEN_TO_ALL.has(key)) return true;
  if (caller.isOwner) return true;
  if (OWNER_ONLY.has(key)) return false;
  return caller.isAdmin;
};

/**
 * How long a debug subscription lasts: a number and a unit, one of minutes, hours,
 * days or years. Rejected rather than guessed at — a typo that silently became a
 * year of direct messages would be a poor surprise.
 */
const UNITS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  y: 31_536_000_000,
  year: 31_536_000_000,
  years: 31_536_000_000,
};

/** A year of it is already absurd; more than that is a mistake or a joke. */
const MAX_DURATION_MS = 31_536_000_000;

export const parseDuration = (input: string): number | null => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(input);
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = UNITS[match[2]!.toLowerCase()];
  if (unit === undefined || !Number.isFinite(amount) || amount <= 0) return null;
  const ms = Math.round(amount * unit);
  return ms > MAX_DURATION_MS ? null : ms;
};

/** Guild-scoped registration: it takes effect immediately, unlike global commands. */
export const registerCommands = async (client: Client<true>, guildId: string): Promise<void> => {
  const rest = new REST().setToken(client.token);
  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: [definition] });
};

/**
 * A handler is given who asked and what they asked with, because the admin and
 * debug commands act on somebody other than the caller.
 */
export type CommandContext = {
  caller: Caller;
  /** The `user` or `recipient` option, when the subcommand takes one. */
  targetUserId: string | null;
  /** The `expiration` option, verbatim and unparsed. */
  expiration: string | null;
};

export type CommandHandlers = Record<string, (context: CommandContext) => string | Promise<string>>;

/** Exception text can carry ids, paths and SQL. It is logged, never posted. */
const FAILED_PUBLICLY = "Something is broken. I do not know which thing. I am looking at it.";

/** "admin add", or plain "pause". One key for the handler table and the tiers. */
const keyOf = (command: ChatInputCommandInteraction): string => {
  const group = command.options.getSubcommandGroup(false);
  const sub = command.options.getSubcommand();
  return group === null ? sub : `${group} ${sub}`;
};

const run = async (
  command: ChatInputCommandInteraction,
  handlers: CommandHandlers,
  isAdmin: (userId: string) => boolean,
  onError: (msg: string, cause: Error) => void,
): Promise<void> => {
  const key = keyOf(command);
  const handler = handlers[key];
  if (handler === undefined) return;

  const userId = command.user.id;
  const caller: Caller = {
    userId,
    // Ownership is read from Discord every time. A stored copy is wrong the moment
    // a server changes hands, and being wrong here locks somebody out of their own
    // server.
    isOwner: command.guild?.ownerId === userId,
    isAdmin: isAdmin(userId),
  };

  if (!mayRun(key, caller)) {
    const content = OWNER_ONLY.has(key)
      ? "Only the one who owns this place says who may do that."
      : "You are not the leader. Only a leader may do that.";
    await command.reply({ content, flags: MessageFlags.Ephemeral });
    return;
  }

  // Gathering holders means several REST reads, which can outrun Discord's
  // three-second reply deadline. Deferring first is the difference between a slow
  // answer and no answer at all.
  //
  // Steering is answered privately: who may steer, and who is being sent the log,
  // is nobody else's business and clutters the channel it was asked in.
  await command.deferReply(OPEN_TO_ALL.has(key) ? {} : { flags: MessageFlags.Ephemeral });
  let content: string;
  try {
    content = await handler({
      caller,
      targetUserId:
        (command.options.getUser("user", false) ?? command.options.getUser("recipient", false))?.id ?? null,
      expiration: command.options.getString("expiration", false),
    });
  } catch (cause) {
    onError(`command "${key}" failed`, cause as Error);
    content = FAILED_PUBLICLY;
  }
  await command.editReply({ content, allowedMentions: { parse: [] } });
};

export const handleCommands = (
  client: Client<true>,
  guildId: string,
  handlers: CommandHandlers,
  isAdmin: (userId: string) => boolean,
  onError: (msg: string, cause: Error) => void = () => {},
): void => {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "helmet" || interaction.guildId !== guildId) return;

    // The emitter never observes the promise this returns, so nothing may escape.
    // A Discord REST failure — a network blip, or an interaction that expired past
    // its three-second deadline — must not take down a process meant to run for
    // weeks.
    void run(interaction, handlers, isAdmin, onError).catch((cause: unknown) => {
      // Reaching here means even replying failed — a REST outage, or an interaction
      // that expired past Discord's deferred window.
      onError("could not answer a command at all", cause as Error);
    });
  });
};
