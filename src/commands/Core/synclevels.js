import { SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
import { reconcileLevelRoles } from '../../services/leveling/levelRoleSyncService.js';
import { getUserLevelData } from '../../services/leveling/leveling.js';
import { getUserLevelPrefix } from '../../utils/database/keys.js';

function isOwner(id) {
  return String(process.env.OWNER_IDS || process.env.OWNER_ID || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(id);
}

export default {
  data: new SlashCommandBuilder()
    .setName('synclevels')
    .setDescription('Owner — reload levels from MongoDB and re-apply Discord roles')
    .addUserOption((o) =>
      o.setName('user').setDescription('Optional: sync one user only'),
    ),
  category: 'core',

  async execute(interaction) {
    if (!isOwner(interaction.user.id)) {
      return interaction.reply({
        content: 'Owner only.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;
    const one = interaction.options.getUser('user');
    const client = interaction.client;

    // Count level docs in Mongo for this guild
    let keys = [];
    try {
      const prefix = getUserLevelPrefix(guild.id);
      keys = (await client.db.list(prefix).catch(() => [])) || [];
      if (!keys.length) {
        const all = (await client.db.list('guild:').catch(() => [])) || [];
        keys = all.filter((k) => k.includes(`${guild.id}:leveling:users:`));
      }
    } catch (_) {}

    let sample = null;
    if (one) {
      sample = await getUserLevelData(client, guild.id, one.id);
    } else if (keys[0]) {
      const uid = keys[0].split(':').pop();
      sample = await getUserLevelData(client, guild.id, uid);
    }

    const summary = await reconcileLevelRoles(client, guild.id);

    const embed = new EmbedBuilder()
      .setColor(0xff4655)
      .setTitle('Level sync from MongoDB')
      .setDescription(
        `Guild \`${guild.id}\`\n` +
          `Level keys found: **${keys.length}**\n` +
          `Roles re-awarded: **${summary.rolesReAwarded}**\n` +
          `Errors: **${summary.errors}**`,
      )
      .setFooter({ text: 'If keys=0, levels for THIS server were never stored under this guild id' });

    if (sample && one) {
      embed.addFields({
        name: `User ${one.tag}`,
        value: `Level **${sample.level}** · XP **${sample.xp}** · Total **${sample.totalXp}**`,
      });
    } else if (sample) {
      embed.addFields({
        name: 'Sample from DB',
        value: `Level **${sample.level}** · XP **${sample.xp}** · Total **${sample.totalXp}**`,
      });
    }

    return interaction.editReply({ embeds: [embed] });
  },
};
