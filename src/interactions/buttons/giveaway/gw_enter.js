import { MessageFlags } from 'discord.js';
import { getUserLevelData } from '../../../services/leveling/leveling.js';

export default {
  name: 'gw_enter',
  async execute(interaction, client, args = []) {
    const giveawayId = args[0] || interaction.customId.split(':')[1];
    const key = `giveaway:${giveawayId}`;
    const g = await client.db.get(key, null);

    if (!g || g.ended) {
      return interaction.reply({
        content: 'This giveaway has ended.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (Date.now() >= g.endsAt) {
      return interaction.reply({
        content: 'This giveaway has ended.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const member = interaction.member;
    const req = g.requirements || {};

    if (req.minLevel != null) {
      const data = await getUserLevelData(
        client,
        interaction.guildId,
        interaction.user.id,
      );
      if ((data.level || 0) < req.minLevel) {
        return interaction.reply({
          content: `You need **level ${req.minLevel}+** (you are ${data.level || 0}).`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    for (const roleId of [req.rankRoleId, req.ageRoleId, req.extraRoleId]) {
      if (roleId && !member.roles.cache.has(roleId)) {
        return interaction.reply({
          content: `Missing required role: <@&${roleId}>`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    g.entrants = g.entrants || [];
    if (g.entrants.includes(interaction.user.id)) {
      return interaction.reply({
        content: 'You are already entered.',
        flags: MessageFlags.Ephemeral,
      });
    }

    g.entrants.push(interaction.user.id);
    await client.db.set(key, g);

    return interaction.reply({
      content: `You're in! (**${g.entrants.length}** entries)`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
