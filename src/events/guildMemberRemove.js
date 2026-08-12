import { Events, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getWelcomeConfig } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { logger } from '../utils/logger.js';

function chunkMessage(text, max = 2000) {
  const s = String(text || '');
  if (s.length <= max) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

export default {
  name: Events.GuildMemberRemove,
  once: false,

  async execute(member) {
    try {
      const { guild, user } = member;
      if (!guild || !user) return;

      const welcomeConfig = await getWelcomeConfig(member.client, guild.id).catch(() => null);
      if (!welcomeConfig?.goodbyeEnabled) return;

      const goodbyeChannelId = welcomeConfig.goodbyeChannelId;
      if (!goodbyeChannelId) return;

      let channel = guild.channels.cache.get(goodbyeChannelId);
      if (!channel) channel = await guild.channels.fetch(goodbyeChannelId).catch(() => null);
      if (!channel?.isTextBased?.()) return;

      const me = guild.members.me;
      const permissions = me ? channel.permissionsFor(me) : null;
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        return;
      }

      const formatData = { user, guild, member };
      const goodbyeMessage = formatWelcomeMessage(
        welcomeConfig.leaveMessage ||
          welcomeConfig.leaveEmbed?.description ||
          '{user.tag} has left the server.',
        formatData,
      );

      const style = String(welcomeConfig.goodbyeStyle || 'embed').toLowerCase();
      const useEmbed =
        (style === 'embed' || style === 'card') &&
        permissions.has(PermissionFlagsBits.EmbedLinks);

      if (useEmbed) {
        const embedTitle = formatWelcomeMessage(
          welcomeConfig.leaveEmbed?.title || 'Goodbye',
          formatData,
        );
        const embedFooter = welcomeConfig.leaveEmbed?.footer
          ? formatWelcomeMessage(welcomeConfig.leaveEmbed.footer, formatData)
          : `Goodbye from ${guild.name}`;

        const embed = new EmbedBuilder()
          .setTitle(embedTitle.slice(0, 256))
          .setDescription(goodbyeMessage.slice(0, 4096))
          .setColor(welcomeConfig.leaveEmbed?.color || 0xed4245)
          .setThumbnail(user.displayAvatarURL({ size: 256 }))
          .addFields(
            { name: 'User', value: `${user.tag || user.username}`, inline: true },
            { name: 'Member Count', value: String(guild.memberCount), inline: true },
          )
          .setTimestamp()
          .setFooter({ text: embedFooter.slice(0, 2048) });

        await channel.send({ embeds: [embed] });
      } else {
        for (const chunk of chunkMessage(goodbyeMessage, 2000)) {
          await channel.send({ content: chunk });
        }
      }
      logger.info(`Goodbye (${style}) sent for ${user.tag} in #${channel.name}`);
    } catch (error) {
      logger.error('guildMemberRemove goodbye:', error?.message || error);
    }
  },
};
