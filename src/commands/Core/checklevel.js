import { SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
import { getUserLevelData } from '../../services/leveling/leveling.js';

function isOwner(userId) {
  const ids = String(process.env.OWNER_IDS || process.env.OWNER_ID || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(userId);
}

export default {
  data: new SlashCommandBuilder()
    .setName('checklevel')
    .setDescription('Owner only — view a member level from MongoDB')
    .addUserOption((o) =>
      o.setName('user').setDescription('Member to inspect').setRequired(true),
    ),
  category: 'core',
  async execute(interaction) {
    if (!isOwner(interaction.user.id)) {
      return interaction.reply({
        content: 'Only the bot owner can use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const user = interaction.options.getUser('user', true);
    const guildId = interaction.guildId;
    const data = await getUserLevelData(interaction.client, guildId, user.id);

    const embed = new EmbedBuilder()
      .setColor(0xff4655)
      .setTitle('Level lookup (MongoDB)')
      .setDescription(`**${user.tag}** (\`${user.id}\`)\nGuild \`${guildId}\``)
      .addFields(
        { name: 'Level', value: String(data.level ?? 0), inline: true },
        { name: 'XP', value: String(data.xp ?? 0), inline: true },
        { name: 'Total XP', value: String(data.totalXp ?? 0), inline: true },
      )
      .setThumbnail(user.displayAvatarURL({ size: 128 }))
      .setFooter({ text: 'Same path as /synclevels · guild-specific' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
