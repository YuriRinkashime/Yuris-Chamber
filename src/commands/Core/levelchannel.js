import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} from 'discord.js';
import {
  getLevelingConfig,
  saveLevelingConfig,
} from '../../services/leveling/leveling.js';

export default {
  data: new SlashCommandBuilder()
    .setName('levelchannel')
    .setDescription('Set the level-up announcement channel (Admin)')
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Where level-ups are posted (not #welcome)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  category: 'core',

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel', true);
    const config = await getLevelingConfig(interaction.client, interaction.guildId);

    config.enabled = true;
    config.levelUpChannel = channel.id;
    config.levelUpMessages = true;
    if (!config.levelUpMessage) {
      config.levelUpMessage = '{user} has leveled up to level {level}!';
    }

    await saveLevelingConfig(interaction.client, interaction.guildId, config);

    return interaction.reply({
      content: `Level-ups will post in ${channel}.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
