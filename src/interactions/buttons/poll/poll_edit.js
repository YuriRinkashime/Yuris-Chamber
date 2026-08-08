import {
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { getPoll, canManagePoll } from '../../../services/pollService.js';

export default {
  name: 'poll_edit',
  async execute(interaction, client, args = []) {
    const pollId = args[0] || interaction.customId.split(':')[1];
    const poll = await getPoll(client, pollId);
    if (!poll) {
      return interaction.reply({
        content: 'Poll not found.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (poll.ended) {
      return interaction.reply({
        content: 'Cannot edit an ended poll.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!canManagePoll(interaction, poll)) {
      return interaction.reply({
        content: 'You need **Manage Messages** (or be the poll creator) to edit this.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const leftSec = poll.endsAt
      ? Math.max(10, Math.ceil((poll.endsAt - Date.now()) / 1000))
      : 300;
    const mins = Math.floor(leftSec / 60);
    const secs = leftSec % 60;

    const modal = new ModalBuilder()
      .setCustomId(`poll_edit_modal:${poll.id}`)
      .setTitle('Edit poll');

    const question = new TextInputBuilder()
      .setCustomId('question')
      .setLabel('Question')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(200)
      .setValue(String(poll.question || '').slice(0, 200));

    const options = new TextInputBuilder()
      .setCustomId('options')
      .setLabel('Options (one per line)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(500)
      .setValue((poll.options || []).map((o) => o.label).join('\n').slice(0, 500));

    const duration = new TextInputBuilder()
      .setCustomId('duration')
      .setLabel('Time left (5 / 90s / 1:30 / 2m30s)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(20)
      .setValue(mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}s`);

    modal.addComponents(
      new ActionRowBuilder().addComponents(question),
      new ActionRowBuilder().addComponents(options),
      new ActionRowBuilder().addComponents(duration),
    );

    await interaction.showModal(modal);
  },
};
