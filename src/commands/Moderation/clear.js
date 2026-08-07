import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';

// Roles that are allowed to use /clear (exact names)
const ALLOWED_ROLE_NAMES = [
  'Mod / Admin (for Yuri)',
  'Owner',
];

export default {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear messages in this channel (Admin / Mod / Owner only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // hides from normal members
    .addIntegerOption(opt =>
      opt
        .setName('amount')
        .setDescription('Number of messages to delete (1–100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(false)
    )
    .addBooleanOption(opt =>
      opt
        .setName('all')
        .setDescription('Try to clear the entire channel')
        .setRequired(false)
    ),

  async execute(interaction) {
    const member = interaction.member;
    const isOwner = interaction.guild.ownerId === interaction.user.id;
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
    const hasModRole = member.roles.cache.some(role =>
      ALLOWED_ROLE_NAMES.includes(role.name)
    );

    // Only Owner, Admin, or Mod role
    if (!isOwner && !isAdmin && !hasModRole) {
      return interaction.reply({
        content: '❌ Only **Admin**, **Mod**, or the **Server Owner** can use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({
        content: '❌ I need **Manage Messages** permission to clear messages.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const amount = interaction.options.getInteger('amount');
    const clearAll = interaction.options.getBoolean('all') || false;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      let totalDeleted = 0;

      if (clearAll) {
        let deleted = 0;
        do {
          const messages = await interaction.channel.messages.fetch({ limit: 100 });
          if (messages.size === 0) break;

          const deletable = messages.filter(
            m => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000
          );
          if (deletable.size === 0) break;

          const result = await interaction.channel.bulkDelete(deletable, true);
          deleted = result.size;
          totalDeleted += deleted;
        } while (deleted > 0);

        await interaction.editReply({
          content: `✅ Cleared **${totalDeleted}** message(s).\n*(Messages older than 14 days cannot be bulk deleted.)*`,
        });
      } else {
        const limit = amount || 10;
        const deleted = await interaction.channel.bulkDelete(limit, true);
        totalDeleted = deleted.size;

        await interaction.editReply({
          content: `✅ Cleared **${totalDeleted}** message(s) from this channel.`,
        });
      }
    } catch (error) {
      console.error('Clear command error:', error);
      await interaction.editReply({
        content: '❌ Failed to clear messages. Check my permissions and that messages are not older than 14 days.',
      });
    }
  },
};
