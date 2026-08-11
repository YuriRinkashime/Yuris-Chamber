import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { parseDuration, endSimpleGiveaway } from '../../commands/Fun/giveaway.js';

export default {
  name: 'giveaway_modal',

  async execute(interaction) {
    const meta = (interaction.customId.split(':')[1] || '').split('|');
    const channelId = meta[0] || interaction.channelId;
    const minLevel = meta[1] ? parseInt(meta[1], 10) : null;
    const ageRoleId = meta[2] || null;
    const rankRoleId = meta[3] || null;
    const extraRoleId = meta[4] || null;

    const prize = interaction.fields.getTextInputValue('prize').trim();
    const durationRaw = interaction.fields.getTextInputValue('duration').trim();
    const winnersRaw = interaction.fields.getTextInputValue('winners').trim();
    let description = '';
    try {
      description = interaction.fields.getTextInputValue('description')?.trim() || '';
    } catch (_) {}

    let durationMs;
    try {
      durationMs = parseDuration(durationRaw);
    } catch (e) {
      return interaction.reply({ content: `❌ ${e.message}`, flags: MessageFlags.Ephemeral });
    }

    const winners = Math.min(20, Math.max(1, parseInt(winnersRaw, 10) || 1));
    const endsAt = Date.now() + durationMs;
    const giveawayId = `${interaction.guildId}-${Date.now()}`;

    const channel =
      interaction.guild.channels.cache.get(channelId) ||
      (await interaction.guild.channels.fetch(channelId).catch(() => null)) ||
      interaction.channel;

    if (!channel?.isTextBased?.()) {
      return interaction.reply({ content: 'Invalid channel.', flags: MessageFlags.Ephemeral });
    }

    const reqLines = [];
    if (minLevel != null && !Number.isNaN(minLevel)) reqLines.push(`📈 Level **${minLevel}+**`);
    if (ageRoleId) reqLines.push(`🎂 Age <@&${ageRoleId}>`);
    if (rankRoleId) reqLines.push(`🎮 Rank <@&${rankRoleId}>`);
    if (extraRoleId) reqLines.push(`🎭 Role <@&${extraRoleId}>`);

    const embed = new EmbedBuilder()
      .setColor(0xff4655)
      .setTitle('🎉 Giveaway')
      .setDescription(
        `**Prize:** ${prize}\n` +
          (description ? `${description}\n\n` : '') +
          `**Winners:** ${winners}\n` +
          `**Ends:** <t:${Math.floor(endsAt / 1000)}:R> (<t:${Math.floor(endsAt / 1000)}:f>)\n` +
          (reqLines.length ? `\n**Requirements**\n${reqLines.join('\n')}` : '\n_No special requirements_') +
          `\n\nClick **Enter** to join!`,
      )
      .setFooter({ text: `Hosted by ${interaction.user.tag}` })
      .setTimestamp(endsAt);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gw_enter:${giveawayId}`)
        .setLabel('Enter')
        .setEmoji('🎉')
        .setStyle(ButtonStyle.Primary),
    );

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const msg = await channel.send({ embeds: [embed], components: [row] });

    const record = {
      id: giveawayId,
      guildId: interaction.guildId,
      channelId: channel.id,
      messageId: msg.id,
      prize,
      description,
      winners,
      winnerCount: winners,
      endsAt,
      hostId: interaction.user.id,
      entrants: [],
      participants: [],
      ended: false,
      isEnded: false,
      paused: false,
      requirements: {
        minLevel: minLevel != null && !Number.isNaN(minLevel) ? minLevel : null,
        ageRoleId: ageRoleId || null,
        rankRoleId: rankRoleId || null,
        extraRoleId: extraRoleId || null,
      },
    };

    await interaction.client.db.set(`giveaway:${giveawayId}`, record);

    // Node setTimeout max ~24.8 days; longer giveaways are ended by the periodic scanner
    const MAX_TIMEOUT = 2147483647;
    const wait = Math.max(0, Math.min(endsAt - Date.now(), MAX_TIMEOUT));
    setTimeout(() => {
      endSimpleGiveaway(interaction.client, giveawayId).catch(() => {});
    }, wait);

    return interaction.editReply({ content: `✅ Giveaway posted in ${channel}.` });
  },
};
