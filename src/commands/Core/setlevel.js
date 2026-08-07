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
  getLevelingConfig,
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
    .addBooleanOption((o) =>
      o
        .setName('announce')
        .setDescription('Post in level-up channel? (default: true)')
        .setRequired(false),
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
    const announce = interaction.options.getBoolean('announce') ?? true;
    const guildId = interaction.guildId;
    const guild = interaction.guild;

    const data = await getUserLevelData(interaction.client, guildId, user.id);
    const oldLevel = data.level ?? 0;
    data.level = level;
    data.xp = xp;
    data.totalXp = calculateTotalXp(level, xp);
    data.lastMessage = Date.now();

    await saveUserLevelData(interaction.client, guildId, user.id, data);

    let announced = false;
    if (announce && guild) {
      try {
        const config = await getLevelingConfig(interaction.client, guildId);
        const channelId = config?.levelUpChannel;
        let channel = channelId
          ? guild.channels.cache.get(channelId)
          : null;
        if (!channel && channelId) {
          channel = await guild.channels.fetch(channelId).catch(() => null);
        }
        if (!channel && guild.systemChannel) {
          channel = guild.systemChannel;
        }

        if (channel?.isTextBased?.()) {
          // Same style as normal level-ups, plus modifier note
          const template =
            config?.levelUpMessage ||
            '{user} has leveled up to level {level}!';
          const memberMention = `<@${user.id}>`;
          const text = template
            .replace(/\{user\}/g, memberMention)
            .replace(/\{level\}/g, String(level))
            .replace(/\{xp\}/g, String(xp))
            .replace(/\{xpNeeded\}/g, String(getXpForLevel(level)));

          await channel.send({
            content: `${text}\n-# modified by Yuri`,
            allowedMentions: { users: [user.id] },
          });
          announced = true;
        }
      } catch (e) {
        // non-fatal
      }
    }

    const next = getXpForLevel(level);
    return interaction.editReply({
      content:
        `Set **${user.tag}** from **${oldLevel}** → **level ${level}** ` +
        `(${xp}/${next} XP this level).\n` +
        `Total XP: **${data.totalXp}**` +
        (announced ? `\nPosted in the level-up channel.` : ''),
    });
  },
};
