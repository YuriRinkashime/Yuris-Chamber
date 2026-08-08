import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags } from 'discord.js';
import {
  getAiConfig,
  generateReply,
  buildSystemInstructions } from '../../../services/aiService.js';
import {
  appendBotDm,
  getThread,
  cancelAutoAi,
  updateOwnerNotify } from '../../../services/dmInboxService.js';
import { isBotOwner } from '../../../config/bot.js';

async function aiReply(interaction, client, userId) {
  if (!isBotOwner(interaction.user.id)) {
    return interaction.reply({
      content: 'Owner only.',
      flags: MessageFlags.Ephemeral,
    });
  }

  cancelAutoAi(userId);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) {
    return interaction.editReply({ content: 'User not found.' });
  }

  const thread = await getThread(client, userId);
  const lastUser = [...(thread.messages || [])]
    .reverse()
    .find((m) => m.from === 'user');
  const userMessage = lastUser?.content || 'Hello';

  try {
    const { generateDmReply } = await import('../../../services/aiService.js');
    let answer = await generateDmReply(client, userId, userMessage);
    answer = String(answer || '')
      .replace(/<@USER_ID>/gi, `<@${userId}>`)
      .replace(/@USER_ID\b/gi, `<@${userId}>`);
    if (!answer.trim()) answer = 'yo';

    const mentionIds = [...answer.matchAll(/<@!?(\d{17,20})>/g)].map((m) => m[1]);
    await user.send({
      content: answer,
      allowedMentions: { users: mentionIds },
    });
    await appendBotDm(client, userId, answer, 'ai');
    await updateOwnerNotify(client, userId, {
      lastSent: answer,
      footer: '🤖 AI reply sent',
    });

    return interaction.editReply({
      content: (`**🤖 AI → ${user.tag}**\n\n${answer}`).slice(0, 2000),
    });
  } catch (e) {
    return interaction.editReply({
      content: `AI error: ${e.message || e}`,
    });
  }
}

async function humanReplyModal(interaction, userId) {
  if (!isBotOwner(interaction.user.id)) {
    return interaction.reply({
      content: 'Owner only.',
      flags: MessageFlags.Ephemeral });
  }

  cancelAutoAi(userId);

  const modal = new ModalBuilder()
    .setCustomId(`dm_modal:${userId}`)
    .setTitle('Reply to user');

  const input = new TextInputBuilder()
    .setCustomId('reply')
    .setLabel('Your message')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1800);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

/** Used by interactionCreate force-route */
export async function handleDmOwnerButton(interaction, client) {
  const [kind, userId] = interaction.customId.split(':');
  if (kind === 'dm_ai') return aiReply(interaction, client, userId);
  if (kind === 'dm_human') return humanReplyModal(interaction, userId);
}

/** Loader format: client.buttons.get('dm_ai') */
export default [
  {
    name: 'dm_ai',
    async execute(interaction, client, args = []) {
      const userId = args[0] || interaction.customId.split(':')[1];
      return aiReply(interaction, client, userId);
    } },
  {
    name: 'dm_human',
    async execute(interaction, client, args = []) {
      const userId = args[0] || interaction.customId.split(':')[1];
      return humanReplyModal(interaction, userId);
    } },
];
