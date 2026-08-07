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

    // Extra user IDs → prepend mentions
    for (const id of parseUserIds(mentionsRaw)) {
      const tag = `<@${id}>`;
      if (!content.includes(tag) && !content.includes(`<@!${id}>`)) {
        content = `${tag} ${content}`;
      }
    }

    const components = [];
    if (btnLabel && btnTarget) {
      let url = btnTarget.trim();
      if (/^\d{17,20}$/.test(url)) {
        url = `https://discord.com/channels/${interaction.guildId}/${url}`;
      }
      if (!/^https?:\/\//i.test(url)) {
        return interaction.reply({
          content: 'Button needs a full https:// link **or** a channel ID (numbers only).',
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
    } else if (btnLabel || btnTarget) {
      return interaction.reply({
        content: 'For a button, fill **both** “Button text” and “Button link”.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const payload = {
      content: content.slice(0, 2000),
      allowedMentions: { parse: ['users', 'roles', 'everyone'] },
    };
    if (components.length) payload.components = components;

    const sent = await channel.send(payload);

    return interaction.reply({
      content: `✅ Posted in ${channel}\n${sent.url}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
