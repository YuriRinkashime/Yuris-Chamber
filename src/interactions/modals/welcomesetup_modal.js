import { MessageFlags } from 'discord.js';
import { getWelcomeConfig, saveWelcomeConfig } from '../../utils/database.js';

export default {
  name: 'welcomesetup_modal',
  async execute(interaction) {
    // customId: welcomesetup_modal:welcome:CHANNEL_ID
    //        or welcomesetup_modal:goodbye:CHANNEL_ID
    const parts = interaction.customId.split(':');
    const type = parts[1]; // welcome | goodbye
    const channelId = parts[2];
    const message = interaction.fields.getTextInputValue('message');

    const guildId = interaction.guild.id;
    const config = (await getWelcomeConfig(interaction.client, guildId)) || {};

    if (type === 'welcome') {
      config.enabled = true;
      config.channelId = channelId;
      config.welcomeMessage = message;
      config.welcomePing = true;
    } else {
      config.goodbyeEnabled = true;
      config.goodbyeChannelId = channelId;
      config.leaveMessage = message;
    }

    await saveWelcomeConfig(interaction.client, guildId, config);

    const channelMention = `<#${channelId}>`;

    await interaction.reply({
      content:
        `✅ **${type === 'welcome' ? 'Welcome' : 'Goodbye'}** messages saved!\n` +
        `Channel: ${channelMention}\n\n` +
        `**Preview:**\n${message}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
