import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ChannelType,
} from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a custom bot message (mentions, optional button)')
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Where to post (default: here)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  category: 'moderation',

  async execute(interaction) {
    const channel =
      interaction.options.getChannel('channel') || interaction.channel;

    const modal = new ModalBuilder()
      .setCustomId(`say_modal:${channel.id}`)
      .setTitle('Yuri says…');

    const content = new TextInputBuilder()
      .setCustomId('content')
      .setLabel('Message (use <@id> or <#id> to mention)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(2000)
      .setPlaceholder('Hello <@123> welcome to <#456> …');

    const mentions = new TextInputBuilder()
      .setCustomId('mentions')
      .setLabel('Extra user IDs to ping (comma-separated)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(200)
      .setPlaceholder('885316532673085482, anotherId');

    const btnLabel = new TextInputBuilder()
      .setCustomId('btn_label')
      .setLabel('Button label (optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(80)
      .setPlaceholder('Join VC / Rules / Website');

    const btnTarget = new TextInputBuilder()
      .setCustomId('btn_target')
      .setLabel('Button: full URL or channel ID')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(300)
      .setPlaceholder('https://…  or  123456789012345678');

    modal.addComponents(
      new ActionRowBuilder().addComponents(content),
      new ActionRowBuilder().addComponents(mentions),
      new ActionRowBuilder().addComponents(btnLabel),
      new ActionRowBuilder().addComponents(btnTarget),
    );

    await interaction.showModal(modal);
  },
};
