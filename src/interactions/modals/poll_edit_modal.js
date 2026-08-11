import { MessageFlags } from 'discord.js';
import {
  getPoll,
  applyPollEdit,
  canManagePoll,
} from '../../services/pollService.js';

import { parseFlexibleDurationSeconds } from '../../utils/duration.js';


export default {
  name: 'poll_edit_modal',
  async execute(interaction) {
    const pollId = interaction.customId.split(':')[1];
    const poll = await getPoll(interaction.client, pollId);
    if (!poll) {
      return interaction.reply({
        content: 'Poll not found.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!canManagePoll(interaction, poll)) {
      return interaction.reply({
        content: 'No permission.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const question = interaction.fields.getTextInputValue('question');
    const optionsText = interaction.fields.getTextInputValue('options');
    const duration = interaction.fields.getTextInputValue('duration');
    let totalSeconds;
    try {
      totalSeconds = parseFlexibleDurationSeconds(duration, {
        minMs: 10_000,
        maxMs: 365 * 86_400_000,
      });
    } catch (_) {
      totalSeconds = undefined;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await applyPollEdit(interaction.client, poll, {
      question,
      optionsText,
      totalSeconds: Number.isFinite(totalSeconds) ? totalSeconds : undefined,
    });

    if (!result.ok) {
      return interaction.editReply({ content: result.error || 'Edit failed' });
    }
    return interaction.editReply({
      content: '✅ Poll updated on Discord + dashboard.',
    });
  },
};
