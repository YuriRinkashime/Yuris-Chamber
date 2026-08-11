import { MessageFlags } from 'discord.js';
import { randomBytes } from 'crypto';
import {
  savePoll,
  buildPollEmbed,
  buildPollButtons,
  upsertOwnerPollCard,
} from '../../services/pollService.js';
import { parseFlexibleDurationSeconds } from '../../utils/duration.js';

export default {
  name: 'poll_modal',
  async execute(interaction) {
    const channelId = interaction.customId.split(':')[1];
    const question = interaction.fields.getTextInputValue('question').trim();
    const rawOptions = interaction.fields.getTextInputValue('options');
    const durationRaw = interaction.fields.getTextInputValue('duration').trim();

    let totalSec;
    try {
      totalSec = parseFlexibleDurationSeconds(durationRaw, {
        minMs: 10_000,
        maxMs: 365 * 86_400_000,
      });
    } catch (e) {
      return interaction.reply({
        content:
          'Duration invalid: ' + e.message + '\n' +
          'Examples: `5` (5 min), `90s`, `2h`, `1d`, `1w`, `2mo`, `1y`, `1d12h`',
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
          'Need **at least 2** options.\nPut each option on its **own line**.',
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
    const endsAt = Date.now() + totalSec * 1000;

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
      ownerNotify: {},
    };

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const msg = await channel.send({
        embeds: [buildPollEmbed(poll)],
        components: buildPollButtons(poll),
      });
      poll.messageId = msg.id;
      await savePoll(interaction.client, poll);
      await upsertOwnerPollCard(interaction.client, poll, {
        note: 'New poll created',
      }).catch(() => {});

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
