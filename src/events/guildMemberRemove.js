import { Events, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getColor, botConfig } from '../config/bot.js';
import { getWelcomeConfig } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildMemberRemove,
  once: false,

  async execute(member) {
    try {
      const { guild, user } = member;
      if (!guild || !user) return;

      const welcomeConfig = await getWelcomeConfig(member.client, guild.id).catch(() => null);
      if (!welcomeConfig?.goodbyeEnabled) return;

      const goodbyeChannelId = welcomeConfig?.goodbyeChannelId;
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
          botConfig.welcome?.defaultGoodbyeMessage ||
          '{user} has left the server.',
        formatData,
      );

      const embedTitle = formatWelcomeMessage(
        welcomeConfig.leaveEmbed?.title || '👋 Goodbye',
        formatData,
      );
      const embedFooter = welcomeConfig.leaveEmbed?.footer
        ? formatWelcomeMessage(welcomeConfig.leaveEmbed.footer, formatData)
        : `Goodbye from ${guild.name}!`;

      if (permissions.has(PermissionFlagsBits.EmbedLinks)) {
        const embed = new EmbedBuilder()
          .setTitle(embedTitle)
          .setDescription(goodbyeMessage)
          .setColor(welcomeConfig.leaveEmbed?.color || getColor('error') || 0xed4245)
          .setThumbnail(user.displayAvatarURL())
          .addFields(
            { name: 'User', value: `${user.tag}`, inline: true },
            { name: 'Member Count', value: String(guild.memberCount), inline: true },
          )
          .setTimestamp()
          .setFooter({ text: embedFooter });

        await channel.send({ embeds: [embed] });
      } else {
        await channel.send({ content: goodbyeMessage });
      }
    } catch (error) {
      logger.error('Error in guildMemberRemove:', error);
    }
  },
};
