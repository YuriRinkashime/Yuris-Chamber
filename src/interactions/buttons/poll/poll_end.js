import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  getPoll,
  endPoll,
  canManagePoll,
} from '../../../services/pollService.js';

export default {
  name: 'poll_end',
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
        content: 'Already ended.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!canManagePoll(interaction, poll)) {
      return interaction.reply({
        content: 'You need **Manage Messages** (or be the poll creator) to end this.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferUpdate().catch(() => {});
    await endPoll(client, poll);
  },
};
