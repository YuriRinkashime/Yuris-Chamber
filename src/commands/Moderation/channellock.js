import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('channellock')
    .setDescription('Only allow specific slash commands in a channel (Admin)')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Lock a channel to listed commands')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Channel to lock')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('commands')
            .setDescription('Allowed command names, comma-separated (e.g. rankupdate)')
            .setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('off')
        .setDescription('Remove lock from a channel')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show locked channels'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  category: 'moderation',

  async execute(interaction) {
    const client = interaction.client;
    const guildId = interaction.guildId;
    const key = `guild:${guildId}:channelLocks`;
    const locks = (await client.db.get(key, {})) || {};
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const channel = interaction.options.getChannel('channel', true);
      const commands = interaction.options
        .getString('commands', true)
        .split(',')
        .map((c) => c.trim().toLowerCase().replace(/^\//, ''))
        .filter(Boolean);

      locks[channel.id] = { commands };
      await client.db.set(key, locks);

      return interaction.reply({
        content:
          `✅ ${channel} only allows: ${commands.map((c) => `\`/${c}\``).join(', ')}\n` +
          `Other messages will be deleted (admins immune).`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'off') {
      const channel = interaction.options.getChannel('channel', true);
      delete locks[channel.id];
      await client.db.set(key, locks);
      return interaction.reply({
        content: `✅ Lock removed from ${channel}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'list') {
      const lines = Object.entries(locks).map(
        ([id, v]) => `<#${id}> → ${(v.commands || []).map((c) => `/${c}`).join(', ')}`,
      );
      return interaction.reply({
        content: lines.length ? lines.join('\n') : 'No locks set.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
