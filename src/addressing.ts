import type { Message } from "discord.js";

/** Whether a message addresses the bot, or null when Discord could not verify it. */
export const isAddressedToBot = async (message: Message, botId: string): Promise<boolean | null> => {
  if (message.mentions.users.has(botId)) return true;

  const reference = message.reference;
  if (reference?.channelId !== message.channelId || reference.messageId === undefined) return false;

  try {
    const target = await message.channel.messages.fetch({ message: reference.messageId, cache: false });
    return target.author.id === botId;
  } catch {
    return null;
  }
};
