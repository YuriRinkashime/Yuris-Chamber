import { Events, PermissionFlagsBits } from 'discord.js';
import { getWelcomeConfig } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildMemberAdd,
  once: false,

  async execute(member) {
    try {
      const { guild, user } = member;

      // Welcome still runs during maintenance (user request)
      const welcomeConfig = await getWelcomeConfig(member.client, guild.id).catch(() => null);
      if (!welcomeConfig?.enabled && !welcomeConfig?.channelId) return;

      const channelId = welcomeConfig?.channelId;
      if (!channelId) return;

      let channel = guild.channels.cache.get(channelId);
      if (!channel) channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased?.()) return;

      const me = guild.members.me;
      const permissions = me ? channel.permissionsFor(me) : null;
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        return;
      }

      const formatData = { user, guild, member };
      const rawText =
        welcomeConfig.welcomeMessage ||
        welcomeConfig.message ||
        welcomeConfig.text ||
        null;

      if (rawText) {
        const content = formatWelcomeMessage(rawText, formatData);
        await channel.send({ content }).catch(() => {});
      } else if (welcomeConfig.welcomeEmbed || welcomeConfig.embed) {
        // leave existing embed path if present in older configs
        const emb = welcomeConfig.welcomeEmbed || welcomeConfig.embed;
        await channel.send({ embeds: [emb] }).catch(() => {});
      }
    } catch (error) {
      logger.error('guildMemberAdd welcome:', error?.message || error);
    }
  },
};
