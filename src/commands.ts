import {
  Events,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";

/**
 * The administrative command surface. Only the controls this ticket needs live
 * here; the read-only reporting commands arrive with their own ticket.
 *
 * Permissions are checked per subcommand rather than on the whole command, so the
 * read-only ones can be added later without becoming admin-only by inheritance.
 */
const definition = new SlashCommandBuilder()
  .setName("helmet")
  .setDescription("The Great Helmet Barrel")
  .addSubcommand((s) => s.setName("status").setDescription("What is happening with the helmets"))
  .addSubcommand((s) => s.setName("next").setDescription("When is the next Helmet Ceremony"))
  .addSubcommand((s) => s.setName("roles").setDescription("Who has which helmet"))
  .addSubcommand((s) => s.setName("pause").setDescription("Stop running Ceremonies"))
  .addSubcommand((s) => s.setName("resume").setDescription("Resume Ceremonies, and clear any circuit breaker"))
  .toJSON();

const ADMIN_ONLY = new Set(["pause", "resume"]);

/** Guild-scoped registration: it takes effect immediately, unlike global commands. */
export const registerCommands = async (client: Client<true>, guildId: string): Promise<void> => {
  const rest = new REST().setToken(client.token);
  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: [definition] });
};

export type CommandHandlers = Record<string, () => string | Promise<string>>;

/** Exception text can carry ids, paths and SQL. It is logged, never posted. */
const FAILED_PUBLICLY = "Something is broken. I do not know which thing. I am looking at it.";

const run = async (
  command: ChatInputCommandInteraction,
  handlers: CommandHandlers,
  onError: (msg: string, cause: Error) => void,
): Promise<void> => {
  const sub = command.options.getSubcommand();
  const handler = handlers[sub];
  if (handler === undefined) return;

  if (ADMIN_ONLY.has(sub) && !command.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await command.reply({ content: "You are not the leader. Only a leader may do that.", flags: MessageFlags.Ephemeral });
    return;
  }

  // Gathering holders means several REST reads, which can outrun Discord's
  // three-second reply deadline. Deferring first is the difference between a slow
  // answer and no answer at all.
  await command.deferReply();
  let content: string;
  try {
    content = await handler();
  } catch (cause) {
    onError(`command "${sub}" failed`, cause as Error);
    content = FAILED_PUBLICLY;
  }
  await command.editReply({ content, allowedMentions: { parse: [] } });
};

export const handleCommands = (
  client: Client<true>,
  guildId: string,
  handlers: CommandHandlers,
  onError: (msg: string, cause: Error) => void = () => {},
): void => {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "helmet" || interaction.guildId !== guildId) return;

    // The emitter never observes the promise this returns, so nothing may escape.
    // A Discord REST failure — a network blip, or an interaction that expired past
    // its three-second deadline — must not take down a process meant to run for
    // weeks.
    void run(interaction, handlers, onError).catch((cause: unknown) => {
      // Reaching here means even replying failed — a REST outage, or an interaction
      // that expired past Discord's deferred window.
      onError("could not answer a command at all", cause as Error);
    });
  });
};
