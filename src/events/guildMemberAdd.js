import { Events, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getColor, botConfig } from '../config/bot.js';
import { getWelcomeConfig } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { logger } from '../utils/logger.js';
import {
  isMaintenanceModeRuntime,
  getMaintenanceMessage,
} from '../services/runtimeSettings.js';

export default {
  name: Events.GuildMemberAdd,
  once: false,

  async execute(member) {
    try {
      const { guild, user } = member;

      if (isMaintenanceModeRuntime()) {
        const msg =
          getMaintenanceMessage() ||
          'Bot is under maintenance, all commands has been disabled. Please wait for the bot to online.';
        try {
          const welcomeConfigEarly = await getWelcomeConfig(member.client, guild.id);
          const channelId = welcomeConfigEarly?.channelId || guild.systemChannelId;
          let channel = channelId ? guild.channels.cache.get(channelId) : null;
          if (!channel && channelId) {
            channel = await guild.channels.fetch(channelId).catch(() => null);
          }
          if (channel?.isTextBased?.()) {
            const me = guild.members.me;
            const perms = channel.permissionsFor(me);
            if (perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
              await channel
                .send({ content: `${user} 🛠️ **Maintenance**\n${msg}` })
                .catch(() => {});
            }
          }
        } catch (_) {}
        await user.send(`🛠️ **${guild.name}** is under maintenance.\n${msg}`).catch(() => {});
      }

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
      // Prefer Firebase fields from /welcomesetup (welcomeMessage / welcomeEmbed)
      const rawText =
        welcomeConfig.welcomeMessage ||
        welcomeConfig.joinMessage ||
        welcomeConfig.welcomeEmbed?.description ||
        welcomeConfig.joinEmbed?.description ||
        botConfig.welcome?.defaultWelcomeMessage ||
        'Welcome {user} to **{server}**!';

      const welcomeMessage = formatWelcomeMessage(rawText, formatData);

      const embedTitle = formatWelcomeMessage(
        welcomeConfig.welcomeEmbed?.title ||
          welcomeConfig.joinEmbed?.title ||
          '👋 Welcome',
        formatData,
      );
      const embedFooter = (
        welcomeConfig.welcomeEmbed?.footer ||
        welcomeConfig.joinEmbed?.footer
      )
        ? formatWelcomeMessage(
            welcomeConfig.welcomeEmbed?.footer || welcomeConfig.joinEmbed?.footer,
            formatData,
          )
        : `Welcome to ${guild.name}!`;

      if (permissions.has(PermissionFlagsBits.EmbedLinks)) {
        const embed = new EmbedBuilder()
          .setTitle(embedTitle)
          .setDescription(welcomeMessage)
          .setColor(
            welcomeConfig.welcomeEmbed?.color ||
              welcomeConfig.joinEmbed?.color ||
              getColor('success') ||
              0xc4a1ff,
          )
          .setThumbnail(user.displayAvatarURL())
          .addFields(
            { name: 'User', value: `${user.tag}`, inline: true },
            { name: 'Member Count', value: String(guild.memberCount), inline: true },
          )
          .setTimestamp()
          .setFooter({ text: embedFooter });

        await channel.send({
          content: welcomeConfig?.welcomePing ? `${user}` : undefined,
          embeds: [embed],
          allowedMentions: welcomeConfig?.welcomePing ? { users: [user.id] } : { parse: [] },
        });
      } else {
        await channel.send({
          content: welcomeConfig?.welcomePing ? `${user} ${welcomeMessage}` : welcomeMessage,
          allowedMentions: welcomeConfig?.welcomePing ? { users: [user.id] } : { parse: [] },
        });
      }
    } catch (error) {
      logger.error('Error in guildMemberAdd:', error);
    }
  },
};
