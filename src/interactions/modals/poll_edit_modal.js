import { MessageFlags } from 'discord.js';
import {
  getPoll,
  applyPollEdit,
  canManagePoll,
} from '../../services/pollService.js';

function parseDuration(str) {
  const s = String(str).trim().toLowerCase();
  const m1 = s.match(/^(\d+)\s*:\s*(\d+)$/);
  if (m1) return parseInt(m1[1], 10) * 60 + parseInt(m1[2], 10);
  const m2 = s.match(/^(\d+)\s*m(?:in(?:ute)?s?)?\s*(\d+)\s*s(?:ec(?:ond)?s?)?$/);
  if (m2) return parseInt(m2[1], 10) * 60 + parseInt(m2[2], 10);
  if (/^\d+\s*s(ec(ond)?s?)?$/.test(s)) return parseInt(s, 10);
  if (/^\d+\s*m(in(ute)?s?)?$/.test(s)) return parseInt(s, 10) * 60;
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 60;
  return NaN;
}

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
    const totalSeconds = parseDuration(duration);

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
