import {
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

function parseUserIds(raw) {
  if (!raw || !String(raw).trim()) return [];
  const ids = [];
  const re = /\d{17,20}/g;
  let m;
  const s = String(raw);
  while ((m = re.exec(s)) !== null) ids.push(m[0]);
  return [...new Set(ids)];
}

export default {
  name: 'say_modal',

  async execute(interaction, client, args = []) {
    const channelId = args[0] || interaction.customId.split(':')[1];
    let content = interaction.fields.getTextInputValue('content') || '';
    const mentionsRaw = interaction.fields.getTextInputValue('mentions') || '';
    const btnLabel = (interaction.fields.getTextInputValue('btn_label') || '').trim();
    const btnTarget = (interaction.fields.getTextInputValue('btn_target') || '').trim();

    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
      return interaction.reply({
        content: 'Channel not found.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Append any extra user IDs as mentions if not already in the message
    const extraIds = parseUserIds(mentionsRaw);
    for (const id of extraIds) {
      const tag = `<@${id}>`;
      if (!content.includes(tag) && !content.includes(`<@!${id}>`)) {
        content = `${tag} ${content}`;
      }
    }

    const components = [];
    if (btnLabel && btnTarget) {
      let url = btnTarget;

      // Channel ID → Discord channel link
      if (/^\d{17,20}$/.test(btnTarget)) {
        url = `https://discord.com/channels/${interaction.guildId}/${btnTarget}`;
      }

      // Must be http(s) for Link buttons
      if (!/^https?:\/\//i.test(url)) {
        return interaction.reply({
          content:
            'Button target must be a full `https://` URL or a channel ID.',
          flags: MessageFlags.Ephemeral,
        });
      }

      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel(btnLabel.slice(0, 80))
            .setStyle(ButtonStyle.Link)
            .setURL(url),
        ),
      );
    }

    // Allow @user, @role, #channel pings from the bot message
    const payload = {
      content: content.slice(0, 2000),
      allowedMentions: {
        parse: ['users', 'roles', 'everyone'],
      },
    };
    if (components.length) payload.components = components;

    const sent = await channel.send(payload);

    return interaction.reply({
      content: `Posted in ${channel}: ${sent.url}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
