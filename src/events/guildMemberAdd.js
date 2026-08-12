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
  name: Events.GuildMemberAdd,
  once: false,

  async execute(member) {
    try {
      const { guild, user } = member;
      const welcomeConfig = await getWelcomeConfig(member.client, guild.id).catch((e) => {
        logger.error('guildMemberAdd getWelcomeConfig:', e?.message || e);
        return null;
      });

      if (!welcomeConfig?.enabled) return;
      const channelId = welcomeConfig.channelId;
      if (!channelId) return;

      let channel = guild.channels.cache.get(channelId);
      if (!channel) channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased?.()) return;

      const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
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
      if (!rawText) return;

      const content = formatWelcomeMessage(rawText, formatData);
      if (!content?.trim()) return;

      const style = String(welcomeConfig.welcomeStyle || 'text').toLowerCase();
      const canEmbed =
        style === 'embed' || style === 'card'
          ? permissions.has(PermissionFlagsBits.EmbedLinks)
          : false;

      if (canEmbed) {
        const title = formatWelcomeMessage(
          welcomeConfig.welcomeEmbed?.title || 'Welcome',
          formatData,
        );
        const embed = new EmbedBuilder()
          .setColor(welcomeConfig.welcomeEmbed?.color || 0xff4655)
          .setTitle(title.slice(0, 256))
          .setDescription(content.slice(0, 4096))
          .setThumbnail(user.displayAvatarURL({ size: 256 }))
          .addFields(
            { name: 'User', value: user.tag || user.username, inline: true },
            { name: 'Member Count', value: String(guild.memberCount), inline: true },
          )
          .setTimestamp()
          .setFooter({
            text: formatWelcomeMessage(
              welcomeConfig.welcomeEmbed?.footer || '{server}',
              formatData,
            ).slice(0, 2048),
          });
        await channel.send({
          content: welcomeConfig.welcomePing ? `${user}` : undefined,
          embeds: [embed],
          allowedMentions: { users: [user.id] },
        });
      } else {
        for (const chunk of chunkMessage(content, 2000)) {
          await channel.send({
            content: chunk,
            allowedMentions: { users: [user.id] },
          });
        }
      }
      logger.info(`Welcome (${style}) sent for ${user.tag} in #${channel.name}`);
    } catch (error) {
      logger.error('guildMemberAdd welcome:', error?.message || error);
    }
  },
};
