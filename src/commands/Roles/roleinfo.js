import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('roleinfo')
    .setDescription('Get user ID, role ID, or list a member roles')
    .addSubcommand((s) =>
      s
        .setName('user')
        .setDescription('Show a user ID and their roles')
        .addUserOption((o) =>
          o.setName('target').setDescription('User').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('role')
        .setDescription('Show a role ID')
        .addRoleOption((o) =>
          o.setName('target').setDescription('Role').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s.setName('me').setDescription('Show your user ID'),
    ),

  category: 'utility',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'me') {
      return interaction.reply({
        content: `Your ID: \`${interaction.user.id}\``,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'user') {
      const user = interaction.options.getUser('target', true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const roles = member
        ? member.roles.cache
            .filter((r) => r.id !== interaction.guild.id)
            .sort((a, b) => b.position - a.position)
            .map((r) => `${r.name} → \`${r.id}\``)
            .join('\n') || 'No roles'
        : 'Not in this server';

      return interaction.reply({
        content:
          `**User:** ${user.tag}\n` +
          `**User ID:** \`${user.id}\`\n` +
          `**Roles:**\n${roles}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'role') {
      const role = interaction.options.getRole('target', true);
      return interaction.reply({
        content:
          `**Role:** ${role.name}\n` +
          `**Role ID:** \`${role.id}\`\n` +
          `**Position:** ${role.position}\n` +
          `**Members:** ${role.members.size}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
