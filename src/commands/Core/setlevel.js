import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import {
  getUserLevelData,
  saveUserLevelData,
  getXpForLevel,
  calculateTotalXp,
} from '../../services/leveling/leveling.js';
import { isBotOwner } from '../../config/bot.js';

export default {
  data: new SlashCommandBuilder()
    .setName('setlevel')
    .setDescription('Set a member level (owner / manage server)')
    .addUserOption((o) =>
      o.setName('user').setDescription('Member').setRequired(true),
    )
    .addIntegerOption((o) =>
      o
        .setName('level')
        .setDescription('Level to set (0–1000)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(1000),
    )
    .addIntegerOption((o) =>
      o
        .setName('xp')
        .setDescription('XP into that level (optional, default 0)')
        .setRequired(false)
        .setMinValue(0),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  category: 'core',

  async execute(interaction) {
    const isOwner = isBotOwner(interaction.user.id);
    const canManage = interaction.memberPermissions?.has(
      PermissionFlagsBits.ManageGuild,
    );
    if (!isOwner && !canManage) {
      return interaction.reply({
        content: 'You need **Manage Server** or owner access.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const user = interaction.options.getUser('user', true);
    const level = interaction.options.getInteger('level', true);
    const xp = interaction.options.getInteger('xp') ?? 0;
    const guildId = interaction.guildId;

    const data = await getUserLevelData(interaction.client, guildId, user.id);
    data.level = level;
    data.xp = xp;
    data.totalXp = calculateTotalXp(level, xp);
    data.lastMessage = Date.now();

    await saveUserLevelData(interaction.client, guildId, user.id, data);

    const next = getXpForLevel(level);
    return interaction.editReply({
      content:
        `Set **${user.tag}** to **level ${level}** (${xp}/${next} XP this level).\n` +
        `Total XP stored: **${data.totalXp}**\n` +
        `Key: \`guild:${guildId}:leveling:users:${user.id}\``,
    });
  },
};
