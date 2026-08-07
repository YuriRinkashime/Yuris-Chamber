import { MessageFlags } from 'discord.js';
import { appendBotDm, cancelAutoAi } from '../../services/dmInboxService.js';
import { isBotOwner } from '../../config/bot.js';

export default {
  name: 'dm_modal',
  async execute(interaction, client, args = []) {
    if (!isBotOwner(interaction.user.id)) {
      return interaction.reply({
        content: 'Owner only.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const userId = args[0] || interaction.customId.split(':')[1];
    cancelAutoAi(userId);

    const text = interaction.fields.getTextInputValue('reply');
    const user = await client.users.fetch(userId).catch(() => null);

    if (!user) {
      return interaction.reply({
        content: 'User not found.',
        flags: MessageFlags.Ephemeral,
      });
    }

        await user.send({ content: text });
    await appendBotDm(client, userId, text, 'owner');

    const { updateOwnerNotify } = await import('../../services/dmInboxService.js');
    await updateOwnerNotify(client, userId, {
      lastSent: text,
      footer: 'Your reply sent',
    });

    return interaction.reply({
      content: (`**You → ${user.tag}**\n\n${text}`).slice(0, 2000),
      flags: MessageFlags.Ephemeral,
    });
  },
};
