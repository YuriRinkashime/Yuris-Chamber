import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { getWelcomeConfig, setInDb } from '../../utils/database.js';

export default {
  data: new SlashCommandBuilder()
    .setName('welcomesetup')
    .setDescription('Set up welcome and goodbye messages (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub
        .setName('welcome')
        .setDescription('Set the welcome channel (opens a popup for the message)')
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('Channel for welcome messages')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('goodbye')
        .setDescription('Set the goodbye channel (opens a popup for the message)')
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('Channel for goodbye messages')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('off')
        .setDescription('Turn off welcome or goodbye')
        .addStringOption(opt =>
          opt
            .setName('type')
            .setDescription('What to turn off')
            .setRequired(true)
            .addChoices(
              { name: 'Welcome', value: 'welcome' },
              { name: 'Goodbye', value: 'goodbye' },
              { name: 'Both', value: 'both' },
            )
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;
    const key = `guild:${guildId}:welcome`;

    if (sub === 'off') {
      let config = (await getWelcomeConfig(interaction.client, guildId)) || {};
      const type = interaction.options.getString('type');

      if (type === 'welcome' || type === 'both') config.enabled = false;
      if (type === 'goodbye' || type === 'both') config.goodbyeEnabled = false;

      await setInDb(key, config);

      return interaction.reply({
        content: `✅ Turned off: **${type}**`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Welcome or Goodbye → open modal for multi-line message
    const channel = interaction.options.getChannel('channel');
    const isWelcome = sub === 'welcome';

    const modal = new ModalBuilder()
      .setCustomId(`welcomesetup_modal:${sub}:${channel.id}`)
      .setTitle(isWelcome ? 'Welcome Message' : 'Goodbye Message');

    const defaultWelcome =
      'Welcome {user} to **{server}**! 🎉\n\nPlease go to #verify and complete verification.\nYou are member #{membercount}.';

    const defaultGoodbye =
      '**{user}** left **{server}**. 👋\nMembers left: {membercount}';

    const messageInput = new TextInputBuilder()
      .setCustomId('message')
      .setLabel('Message (use Enter for new lines)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(2000)
      .setValue(isWelcome ? defaultWelcome : defaultGoodbye)
      .setPlaceholder('Type your message here. Press Enter for a new line.');

    modal.addComponents(new ActionRowBuilder().addComponents(messageInput));

    await interaction.showModal(modal);
  },
};
