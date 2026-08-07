import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { formatLogLine } from '../utils/logging/logEmbeds.js';

const MAX_LOGGED_MESSAGE_CONTENT_LENGTH = 1024;

export default {
  name: Events.MessageDelete,
  once: false,

  async execute(message) {
    try {
      if (!message.guild) return;
      if (message.author?.bot) return;

      const content = message.content
        ? message.content.slice(0, MAX_LOGGED_MESSAGE_CONTENT_LENGTH)
        : '(no content / embed / sticker)';

      try {
        await logEvent({
          client: message.client,
          guildId: message.guild.id,
          eventType: EVENT_TYPES.MESSAGE_DELETE,
          data: {
            title: 'Message Deleted',
            lines: [
              formatLogLine('Author', message.author ? `${message.author.tag}` : 'Unknown'),
              formatLogLine(
                'Channel',
                message.channel ? `${message.channel}` : 'Unknown',
              ),
              formatLogLine('Content', content),
            ],
            userId: message.author?.id,
          },
        });
      } catch (logError) {
        logger.warn('Failed to log message delete:', logError);
      }
    } catch (error) {
      logger.error('Error in messageDelete:', error);
    }
  },
};
