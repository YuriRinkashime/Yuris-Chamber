import { SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
import {
  formatUptime,
  getBotStartedAt,
  isMaintenanceModeRuntime,
  getMaintenanceMessage,
} from '../../services/runtimeSettings.js';
import { isBotOwner } from '../../config/bot.js';

export default {
  data: new SlashCommandBuilder()
    .setName('botstatus')
    .setDescription('Owner-only: bot uptime and status'),

  category: 'core',

  async execute(interaction) {
    if (!isBotOwner(interaction.user.id)) {
      return interaction.reply({
        content: '❌ Owner only.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Note: if maintenance is ON, this is also blocked for everyone including owner.
    // Turn maintenance OFF from the web dashboard to use this command.

    const client = interaction.client;
    const mem = process.memoryUsage();
    const embed = new EmbedBuilder()
      .setTitle("Yuri's Chamber · Status")
      .setColor(isMaintenanceModeRuntime() ? 0xed4245 : 0x57f287)
      .addFields(
        { name: 'Online as', value: client.user?.tag || 'unknown', inline: true },
        { name: 'Uptime', value: formatUptime(Date.now() - getBotStartedAt()), inline: true },
        { name: 'Ping', value: `${Math.round(client.ws.ping)} ms`, inline: true },
        { name: 'Guilds', value: String(client.guilds.cache.size), inline: true },
        { name: 'Commands', value: String(client.commands?.size || 0), inline: true },
        {
          name: 'Memory',
          value: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
          inline: true,
        },
        {
          name: 'Maintenance',
          value: isMaintenanceModeRuntime()
            ? `**ON**\n${getMaintenanceMessage()}`
            : '**OFF**',
        },
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
