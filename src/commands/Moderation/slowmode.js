import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Set slowmode for a channel (Mod)')
    .addIntegerOption((o) =>
      o
        .setName('seconds')
        .setDescription('Slowmode delay (0 = off, max 21600)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(21600),
    )
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Channel (default: this channel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  category: 'moderation',

  async execute(interaction) {
    const seconds = interaction.options.getInteger('seconds', true);
    const channel =
      interaction.options.getChannel('channel') || interaction.channel;

    if (!channel?.isTextBased?.()) {
      return interaction.reply({
        content: 'That channel does not support slowmode.',
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      await channel.setRateLimitPerUser(
        seconds,
        `Slowmode set by ${interaction.user.tag}`,
      );

      if (seconds === 0) {
        return interaction.reply({
          content: `Slowmode **disabled** in ${channel}.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      return interaction.reply({
        content: `Slowmode in ${channel} set to **${seconds}** second(s).`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      return interaction.reply({
        content: `Failed: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
