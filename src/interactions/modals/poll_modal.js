import { MessageFlags } from 'discord.js';
import { randomBytes } from 'crypto';
import {
  savePoll,
  buildPollEmbed,
  buildPollButtons,
  notifyOwnersPoll,
} from '../../services/pollService.js';

export default {
  name: 'poll_modal',
  async execute(interaction) {
    const channelId = interaction.customId.split(':')[1];
    const question = interaction.fields.getTextInputValue('question').trim();
    const rawOptions = interaction.fields.getTextInputValue('options');
    const minutesRaw = interaction.fields.getTextInputValue('minutes').trim();

    const minutes = parseInt(minutesRaw, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10080) {
      return interaction.reply({
        content: 'Minutes must be a number from **1** to **10080** (7 days).',
        flags: MessageFlags.Ephemeral,
      });
    }

    const labels = rawOptions
      .split(/\r?\n|\|/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);

    if (labels.length < 2) {
      return interaction.reply({
        content:
          'Need **at least 2** options.\nPut each option on its **own line** (or separate with `|`).',
        flags: MessageFlags.Ephemeral,
      });
    }

    const channel =
      interaction.guild.channels.cache.get(channelId) ||
      (await interaction.guild.channels.fetch(channelId).catch(() => null));

    if (!channel?.isTextBased?.()) {
      return interaction.reply({
        content: 'Could not find that channel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const options = labels.map((label, i) => ({
      id: i,
      label: label.slice(0, 80),
      votes: [],
    }));

    const pollId = randomBytes(6).toString('hex');
    const endsAt = Date.now() + minutes * 60 * 1000;

    const poll = {
      id: pollId,
      guildId: interaction.guildId,
      channelId: channel.id,
      messageId: null,
      question,
      options,
      endsAt,
      ended: false,
      showCounts: false,
      createdBy: interaction.user.id,
      createdAt: Date.now(),
    };

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const msg = await channel.send({
        embeds: [buildPollEmbed(poll)],
        components: buildPollButtons(poll),
      });
      poll.messageId = msg.id;
      await savePoll(interaction.client, poll);

      notifyOwnersPoll(
        interaction.client,
        `📊 **New poll**\n**${question}**\n` +
          `${options.length} options · ends <t:${Math.floor(endsAt / 1000)}:R>\n` +
          `${channel}`,
      ).catch(() => {});

      return interaction.editReply({
        content:
          `✅ Poll posted in ${channel}\n` +
          `**${question}**\n` +
          `${options.length} options · ends <t:${Math.floor(endsAt / 1000)}:R>`,
      });
    } catch (e) {
      return interaction.editReply({
        content: `Failed to post poll: ${e.message || e}`,
      });
    }
  },
};
