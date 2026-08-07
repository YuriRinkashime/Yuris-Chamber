import {
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';
import { setBirthday, getUserBirthday, deleteBirthday } from '../../services/birthdayService.js';

function ageFromYMD(year, month, day) {
  const now = new Date();
  let age = now.getFullYear() - year;
  const m = now.getMonth() + 1;
  const d = now.getDate();
  if (m < month || (m === month && d < day)) age--;
  return age;
}

function ageRoleName(age) {
  if (age >= 24) return '24+';
  if (age >= 18) return '18-23';
  if (age >= 13) return '13-17';
  return null; // under 13 — don't assign
}

const AGE_ROLES = ['13-17', '18-23', '24+'];

export default {
  data: new SlashCommandBuilder()
    .setName('birthday')
    .setDescription('Set or view your birthday (auto age roles)')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set your birthday (YYYY-MM-DD)')
        .addIntegerOption((o) =>
          o.setName('year').setDescription('Birth year e.g. 2008').setRequired(true).setMinValue(1950).setMaxValue(2015),
        )
        .addIntegerOption((o) =>
          o.setName('month').setDescription('Month 1-12').setRequired(true).setMinValue(1).setMaxValue(12),
        )
        .addIntegerOption((o) =>
          o.setName('day').setDescription('Day 1-31').setRequired(true).setMinValue(1).setMaxValue(31),
        ),
    )
    .addSubcommand((s) =>
      s.setName('view').setDescription('View your saved birthday'),
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Remove your birthday'),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const client = interaction.client;
    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    if (sub === 'set') {
      const year = interaction.options.getInteger('year');
      const month = interaction.options.getInteger('month');
      const day = interaction.options.getInteger('day');

      const age = ageFromYMD(year, month, day);
      if (age < 13) {
        return interaction.reply({
          content: '❌ You must be at least 13 to use this server feature.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await setBirthday(client, guildId, userId, month, day, year);

      // Update age role now
      const roleName = ageRoleName(age);
      const member = interaction.member;
      const me = interaction.guild.members.me;
      if (roleName && me?.permissions.has('ManageRoles')) {
        const role = interaction.guild.roles.cache.find((r) => r.name === roleName);
        if (role && role.position < me.roles.highest.position) {
          const toRemove = member.roles.cache.filter((r) => AGE_ROLES.includes(r.name));
          if (toRemove.size) await member.roles.remove(toRemove).catch(() => {});
          await member.roles.add(role).catch(() => {});
        }
      }

      return interaction.reply({
        content:
          `✅ Birthday saved: **${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}**\n` +
          `Age: **${age}** → role **${roleName || 'none'}**\n` +
          `On your birthday the bot will greet you and update your age role if needed.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'view') {
      const b = await getUserBirthday(client, guildId, userId);
      if (!b) {
        return interaction.reply({
          content: '❌ No birthday set. Use `/birthday set`.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const yearPart = b.year ? `${b.year}-` : '';
      return interaction.reply({
        content: `🎂 Your birthday: **${yearPart}${b.monthName} ${b.day}**`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'remove') {
      await deleteBirthday(client, guildId, userId);
      return interaction.reply({
        content: '✅ Birthday removed.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
