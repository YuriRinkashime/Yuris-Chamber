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
        .setDescription('Where to post the poll')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addBooleanOption((o) =>
      o
        .setName('show_votes')
        .setDescription('Show live vote counts? (default: hidden until end)'),
    )
    .addStringOption((o) =>
      o
        .setName('style')
        .setDescription('Message style')
        .addChoices(
          { name: 'Card (embed)', value: 'embed' },
          { name: 'Text only', value: 'text' },
          { name: 'Text + card', value: 'both' },
        ),
    )
    .addStringOption((o) =>
      o
        .setName('on_tie')
        .setDescription('If votes tie when the poll ends')
        .addChoices(
          { name: 'Keep as tie', value: 'keep' },
          { name: 'Random / 50-50 gamble among tied', value: 'random' },
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  category: 'utility',

  async execute(interaction) {
    const channel =
      interaction.options.getChannel('channel') || interaction.channel;
    const showVotes = interaction.options.getBoolean('show_votes') || false;
    const style = interaction.options.getString('style') || 'embed';
    const onTie = interaction.options.getString('on_tie') || 'keep';

    const meta = [channel.id, showVotes ? '1' : '0', style, onTie].join('|');

    const modal = new ModalBuilder()
      .setCustomId(`poll_modal:${meta}`)
      .setTitle('Create poll');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('question')
          .setLabel('Question')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('options')
          .setLabel('Options (one per line, 2–20)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500)
          .setPlaceholder('Reyna\nJett\nChamber'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('minutes')
          .setLabel('Duration (e.g. 60, 90s, 2h, 1d)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12)
          .setValue('60'),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('settings')
          .setLabel('Optional overrides (votes=yes style=both tie=random)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(80)
          .setPlaceholder('Leave blank to use slash options'),
      ),
    );

    await interaction.showModal(modal);
  },
};
