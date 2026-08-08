import { MessageFlags } from 'discord.js';
import {
  getPoll,
  savePoll,
  buildPollEmbed,
  buildPollButtons,
  endPoll,
} from '../../../services/pollService.js';

export default {
  name: 'poll_vote',
  async execute(interaction, client, args = []) {
    const pollId = args[0] || interaction.customId.split(':')[1];
    const optionIndex = Number(args[1] ?? interaction.customId.split(':')[2]);

    if (!pollId || Number.isNaN(optionIndex)) {
      return interaction.reply({
        content: 'Invalid poll button.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const poll = await getPoll(client, pollId);
    if (!poll) {
      return interaction.reply({
        content: 'This poll no longer exists.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (poll.ended || (poll.endsAt && Date.now() >= poll.endsAt)) {
      if (!poll.ended) await endPoll(client, poll);
      return interaction.reply({
        content: 'This poll has ended.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const opt = poll.options[optionIndex];
    if (!opt) {
      return interaction.reply({
        content: 'That option is gone.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const userId = interaction.user.id;
    for (const o of poll.options) {
      o.votes = (o.votes || []).filter((id) => id !== userId);
    }
    opt.votes = opt.votes || [];
    opt.votes.push(userId);
    await savePoll(client, poll);

    try {
      await interaction.update({
        embeds: [buildPollEmbed(poll)],
        components: buildPollButtons(poll),
      });
    } catch {
      await interaction
        .reply({
          content: `Vote locked in: **${opt.label}**`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  },
};
