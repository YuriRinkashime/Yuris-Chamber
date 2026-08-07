import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ChannelType,
} from 'discord.js';

/**
 * /say — bot posts a message as itself.
 * Opens a form:
 *  1) Message text (can include <@userId> and <#channelId>)
 *  2) Optional extra pings (user IDs)
 *  3) Optional button label
 *  4) Optional button link (https://… or a channel ID)
 */
export default {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Make the bot post a message (optional ping + button)')
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Channel to post in (default: this channel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  category: 'moderation',

  async execute(interaction) {
    const channel =
      interaction.options.getChannel('channel') || interaction.channel;

    const modal = new ModalBuilder()
      .setCustomId(`say_modal:${channel.id}`)
      .setTitle('Post as Yuri');

    const content = new TextInputBuilder()
      .setCustomId('content')
      .setLabel('1. Message text')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(2000)
      .setPlaceholder('Write the message. Tip: <@USER_ID> pings someone.');

    const mentions = new TextInputBuilder()
      .setCustomId('mentions')
      .setLabel('2. Extra pings (user IDs, optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(200)
      .setPlaceholder('Only numbers, comma-separated');

    const btnLabel = new TextInputBuilder()
      .setCustomId('btn_label')
      .setLabel('3. Button text (optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(80)
      .setPlaceholder('e.g. Rules / Website / Join');

    const btnTarget = new TextInputBuilder()
      .setCustomId('btn_target')
      .setLabel('4. Button link or channel ID (optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(300)
      .setPlaceholder('https://...  OR  channel ID numbers');

    modal.addComponents(
      new ActionRowBuilder().addComponents(content),
      new ActionRowBuilder().addComponents(mentions),
      new ActionRowBuilder().addComponents(btnLabel),
      new ActionRowBuilder().addComponents(btnTarget),
    );

    await interaction.showModal(modal);
  },
};
