import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create a timed button poll (opens a form)')
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Where to post the poll (default: this channel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  category: 'utility',

  async execute(interaction) {
    const channel =
      interaction.options.getChannel('channel') || interaction.channel;

    const modal = new ModalBuilder()
      .setCustomId(`poll_modal:${channel.id}`)
      .setTitle('Create poll');

    const question = new TextInputBuilder()
      .setCustomId('question')
      .setLabel('Question')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(200)
      .setPlaceholder('e.g. Best agent this act?');

    const options = new TextInputBuilder()
      .setCustomId('options')
      .setLabel('Options (one per line, 2–20)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(500)
      .setPlaceholder('Reyna\nJett\nChamber\nOmen');

    const duration = new TextInputBuilder()
      .setCustomId('duration')
      .setLabel('Duration (5m / 2h / 1d / 1w / 1mo / 1y)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(24)
      .setPlaceholder('e.g. 1d or 2h30m or 1w')
      .setValue('1h');

    modal.addComponents(
      new ActionRowBuilder().addComponents(question),
      new ActionRowBuilder().addComponents(options),
      new ActionRowBuilder().addComponents(duration),
    );

    await interaction.showModal(modal);
  },
};
