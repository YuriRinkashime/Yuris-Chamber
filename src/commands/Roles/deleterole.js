import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('deleterole')
    .setDescription('Delete a role (Admin)')
    .addRoleOption((o) =>
      o.setName('role').setDescription('Role to delete').setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  category: 'roles',

  async execute(interaction) {
    const role = interaction.options.getRole('role', true);
    const me = interaction.guild.members.me;

    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({
        content: 'I need **Manage Roles**.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (role.managed) {
      return interaction.reply({
        content: 'That role is managed by an integration and cannot be deleted.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (role.id === interaction.guild.id) {
      return interaction.reply({
        content: 'Cannot delete @everyone.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (role.position >= me.roles.highest.position) {
      return interaction.reply({
        content: 'That role is higher or equal to my highest role. Move my role up first.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const name = role.name;
    const id = role.id;

    try {
      await role.delete(`Deleted by ${interaction.user.tag} via /deleterole`);
      return interaction.reply({
        content: `Deleted role **${name}** (\`${id}\`).`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      return interaction.reply({
        content: `Failed: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
