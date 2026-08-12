import { Events, PermissionFlagsBits } from 'discord.js';
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

      // Must be explicitly enabled + have a channel
      if (!welcomeConfig?.enabled) {
        logger.debug(`Welcome disabled for guild ${guild.id}`);
        return;
      }
      const channelId = welcomeConfig.channelId;
      if (!channelId) {
        logger.warn(`Welcome enabled but no channelId for guild ${guild.id}`);
        return;
      }

      let channel = guild.channels.cache.get(channelId);
      if (!channel) channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased?.()) {
        logger.warn(`Welcome channel missing/invalid: ${channelId}`);
        return;
      }

      const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
      const permissions = me ? channel.permissionsFor(me) : null;
      if (
        !permissions?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
        ])
      ) {
        logger.warn(`No permission to send welcome in #${channel.name}`);
        return;
      }

      const formatData = { user, guild, member };
      const rawText =
        welcomeConfig.welcomeMessage ||
        welcomeConfig.message ||
        welcomeConfig.text ||
        null;

      if (!rawText) {
        logger.warn(`Welcome enabled but empty message for guild ${guild.id}`);
        return;
      }

      const content = formatWelcomeMessage(rawText, formatData);
      if (!content?.trim()) {
        logger.warn('Welcome message empty after format');
        return;
      }

      const chunks = chunkMessage(content, 2000);
      for (let i = 0; i < chunks.length; i++) {
        await channel.send({
          content: chunks[i],
          allowedMentions: { users: [user.id] },
        });
      }
      logger.info(`Welcome sent for ${user.tag} in #${channel.name}`);
    } catch (error) {
      logger.error('guildMemberAdd welcome:', error?.message || error);
    }
  },
};
