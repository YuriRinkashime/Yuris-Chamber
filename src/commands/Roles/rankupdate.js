import {
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';
import { getFromDb, setInDb } from '../../utils/database.js';

const RANK_CHOICES = [
  { name: 'Iron', value: 'Iron' },
  { name: 'Bronze', value: 'Bronze' },
  { name: 'Silver', value: 'Silver' },
  { name: 'Gold', value: 'Gold' },
  { name: 'Platinum', value: 'Platinum' },
  { name: 'Diamond', value: 'Diamond' },
  { name: 'Ascendant', value: 'Ascendant' },
  { name: 'Immortal', value: 'Immortal' },
  { name: 'Radiant', value: 'Radiant' },
];

const RANK_NAMES = RANK_CHOICES.map(r => r.value);
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

export default {
  data: new SlashCommandBuilder()
    .setName('rankupdate')
    .setDescription('Change your Valorant rank (24 hour cooldown)')
    .addStringOption(opt =>
      opt.setName('rank')
        .setDescription('Your new rank')
        .setRequired(true)
        .addChoices(...RANK_CHOICES)
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const newRankName = interaction.options.getString('rank');
    const key = `rankupdate:${userId}`;

    const lastUsed = await getFromDb(key, 0);
    const now = Date.now();

    if (lastUsed && now - Number(lastUsed) < COOLDOWN_MS) {
      const remaining = COOLDOWN_MS - (now - Number(lastUsed));
      const hours = Math.ceil(remaining / (60 * 60 * 1000));
      return interaction.reply({
        content: `⏳ You can change your rank again in **${hours} hour(s)**.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const member = interaction.member;
    const guild = interaction.guild;
    const newRole = guild.roles.cache.find(r => r.name === newRankName);

    if (!newRole) {
      return interaction.reply({
        content: `Role **${newRankName}** does not exist. Ask an admin to create it.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (newRole.position >= guild.members.me.roles.highest.position) {
      return interaction.reply({
        content: 'My role is too low to assign that rank. Ask an admin to move my role higher.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const toRemove = member.roles.cache.filter(r => RANK_NAMES.includes(r.name) && r.id !== newRole.id);
    if (toRemove.size > 0) await member.roles.remove(toRemove);
    await member.roles.add(newRole);

    await setInDb(key, now);

    await interaction.reply({
      content: `✅ Your rank has been updated to **${newRankName}**!`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
