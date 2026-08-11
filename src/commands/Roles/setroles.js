import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';

const DEFAULT_RANKS = [
  'Iron', 'Bronze', 'Silver', 'Gold', 'Platinum',
  'Diamond', 'Ascendant', 'Immortal', 'Radiant',
  'Unranked', "Doesn't Play Valo",
];

export default {
  data: new SlashCommandBuilder()
    .setName('setroles')
    .setDescription('Create or list rank roles (Admin)')
    .addSubcommand((s) =>
      s.setName('create-ranks').setDescription('Create missing Valorant rank roles'),
    )
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Create one custom role')
        .addStringOption((o) =>
          o.setName('name').setDescription('Role name').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s.setName('list').setDescription('List rank-like roles'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  category: 'roles',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const me = guild.members.me;

    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({
        content: 'I need **Manage Roles**.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'create-ranks') {
      const created = [];
      const skipped = [];
      for (const name of DEFAULT_RANKS) {
        const exists = guild.roles.cache.find((r) => r.name === name);
        if (exists) {
          skipped.push(name);
          continue;
        }
        await guild.roles.create({
          name,
          reason: `setroles by ${interaction.user.tag}`,
        });
        created.push(name);
      }
      return interaction.reply({
        content:
          `Created: ${created.join(', ') || 'none'}\n` +
          `Already existed: ${skipped.join(', ') || 'none'}\n` +
          `Drag role order in Server Settings → Roles (higher = higher priority).`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'create') {
      const name = interaction.options.getString('name', true);
      if (guild.roles.cache.find((r) => r.name === name)) {
        return interaction.reply({
          content: `Role **${name}** already exists.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      const role = await guild.roles.create({
        name,
        reason: `setroles by ${interaction.user.tag}`,
      });
      return interaction.reply({
        content: `Created ${role}. Move it in Server Settings → Roles for priority.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'list') {
      const ranks = DEFAULT_RANKS.map((n) => {
        const r = guild.roles.cache.find((x) => x.name === n);
        return r ? `${r} (${r.position})` : `~~${n}~~ missing`;
      });
      return interaction.reply({
        content: `**Rank roles**\n${ranks.join('\n')}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
