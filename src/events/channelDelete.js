import { logger } from '../utils/logger.js';

export default {
  name: 'channelDelete',
  async execute(channel, client) {
    try {
      if (!channel?.guild) return;
      // Tickets / join-to-create / counters removed — nothing to clean up
      logger.debug?.(`Channel deleted: ${channel.id} in ${channel.guild.id}`);
    } catch (error) {
      logger.error('Error in channelDelete event:', error);
    }
  },
};
