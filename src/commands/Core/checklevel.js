import { SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';

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
    .setDescription('Owner only — view a member\'s level and XP')
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
    const key = `guild:${guildId}:leveling:users:${user.id}`;
    const data = (await interaction.client.db.get(key, null)) || {};
    const level = data.level ?? data.lvl ?? 0;
    const xp = data.xp ?? data.exp ?? 0;
    const totalXp = data.totalXp ?? data.total_xp ?? xp;

    const embed = new EmbedBuilder()
      .setColor(0xff4655)
      .setTitle('Level lookup')
      .setDescription(`**${user.tag}** (\`${user.id}\`)`)
      .addFields(
        { name: 'Level', value: String(level), inline: true },
        { name: 'XP', value: String(xp), inline: true },
        { name: 'Total XP', value: String(totalXp), inline: true },
      )
      .setThumbnail(user.displayAvatarURL({ size: 128 }))
      .setFooter({ text: 'Owner only · MongoDB' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
