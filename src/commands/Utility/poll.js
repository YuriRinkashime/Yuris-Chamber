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
      .setLabel('Duration (5 / 90s / 1:30 / 2m30s)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(20)
      .setPlaceholder('60s or 5 or 1:30')
      .setValue('5');

    modal.addComponents(
      new ActionRowBuilder().addComponents(question),
      new ActionRowBuilder().addComponents(options),
      new ActionRowBuilder().addComponents(duration),
    );

    await interaction.showModal(modal);
  },
};
