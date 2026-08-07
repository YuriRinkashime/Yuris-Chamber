import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
  ComponentType,
} from 'discord.js';

const ROLE_MAP = {
  age_13_15: '13-15',
  age_16_17: '16-17',
  age_18: '18+',
  gender_male: 'Male',
  gender_female: 'Female',
  gender_other: 'Non-binary / Other',
  rank_iron: 'Iron',
  rank_bronze: 'Bronze',
  rank_silver: 'Silver',
  rank_gold: 'Gold',
  rank_platinum: 'Platinum',
  rank_diamond: 'Diamond',
  rank_ascendant: 'Ascendant',
  rank_immortal: 'Immortal',
  rank_radiant: 'Radiant',
};

const AGE_ROLES = ['13-15', '16-17', '18+'];
const GENDER_ROLES = ['Male', 'Female', 'Non-binary / Other'];
const RANK_ROLES = [
  'Iron', 'Bronze', 'Silver', 'Gold', 'Platinum',
  'Diamond', 'Ascendant', 'Immortal', 'Radiant',
];

async function setRole(guild, userId, roleName, groupNames) {
  const member = await guild.members.fetch(userId);
  const role = guild.roles.cache.find(r => r.name === roleName);
  if (!role) throw new Error(`Role "${roleName}" not found. Create it first.`);

  const me = guild.members.me;
  if (!me.permissions.has('ManageRoles')) {
    throw new Error('I need **Manage Roles** permission.');
  }
  if (role.position >= me.roles.highest.position) {
    throw new Error(`Move my role above "${roleName}".`);
  }

  const remove = member.roles.cache
    .filter(r => groupNames.includes(r.name) && r.id !== role.id)
    .map(r => r.id);

  if (remove.length) await member.roles.remove(remove);
  await member.roles.add(role.id);
}

export default {
  name: 'start_verify',
  async execute(interaction) {
    const ageRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('verify_age')
        .setPlaceholder('Select your age...')
        .addOptions(
          { label: '13-15', value: 'age_13_15', emoji: '🟢' },
          { label: '16-17', value: 'age_16_17', emoji: '🟡' },
          { label: '18+', value: 'age_18', emoji: '🔴' },
        )
    );

    const reply = await interaction.reply({
      content: '**Step 1/3 — Choose your Age**',
      components: [ageRow],
      flags: MessageFlags.Ephemeral,
      withResponse: true,
    });

    // Prefer the message from the response; fallback for older discord.js
    const message =
      reply?.resource?.message ??
      (await interaction.fetchReply().catch(() => null));

    if (!message) {
      console.error('start_verify: could not get reply message for collector');
      return;
    }

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      filter: i => i.user.id === interaction.user.id,
      time: 5 * 60 * 1000, // 5 minutes
    });

    collector.on('collect', async i => {
      try {
        if (i.customId === 'verify_age') {
          const roleName = ROLE_MAP[i.values[0]];
          await setRole(i.guild, i.user.id, roleName, AGE_ROLES);

          const genderRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('verify_gender')
              .setPlaceholder('Select your gender...')
              .addOptions(
                { label: 'Male', value: 'gender_male', emoji: '🔵' },
                { label: 'Female', value: 'gender_female', emoji: '🔴' },
                { label: 'Non-binary / Other', value: 'gender_other', emoji: '🟣' },
              )
          );

          await i.update({
            content: `✅ Age set to **${roleName}**\n\n**Step 2/3 — Choose your Gender**`,
            components: [genderRow],
          });
          return;
        }

        if (i.customId === 'verify_gender') {
          const roleName = ROLE_MAP[i.values[0]];
          await setRole(i.guild, i.user.id, roleName, GENDER_ROLES);

          const rankRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('verify_rank')
              .setPlaceholder('Select your Valorant rank...')
              .addOptions(
                { label: 'Iron', value: 'rank_iron', emoji: '⚫' },
                { label: 'Bronze', value: 'rank_bronze', emoji: '🟤' },
                { label: 'Silver', value: 'rank_silver', emoji: '⚪' },
                { label: 'Gold', value: 'rank_gold', emoji: '🟡' },
                { label: 'Platinum', value: 'rank_platinum', emoji: '🔵' },
                { label: 'Diamond', value: 'rank_diamond', emoji: '💎' },
                { label: 'Ascendant', value: 'rank_ascendant', emoji: '🟢' },
                { label: 'Immortal', value: 'rank_immortal', emoji: '🔴' },
                { label: 'Radiant', value: 'rank_radiant', emoji: '✨' },
              )
          );

          await i.update({
            content: `✅ Gender set to **${roleName}**\n\n**Step 3/3 — Choose your Valorant Rank**`,
            components: [rankRow],
          });
          return;
        }

        if (i.customId === 'verify_rank') {
          const roleName = ROLE_MAP[i.values[0]];
          await setRole(i.guild, i.user.id, roleName, RANK_ROLES);

          const verified = i.guild.roles.cache.find(r => r.name === 'Verified');
          if (verified) {
            const member = await i.guild.members.fetch(i.user.id);
            const me = i.guild.members.me;
            if (verified.position < me.roles.highest.position) {
              await member.roles.add(verified.id).catch(() => {});
            }
          }

          await i.update({
            content: `✅ Rank set to **${roleName}**\n\n🎉 **You are now verified!** Welcome to BANORANT!`,
            components: [],
          });
          collector.stop('done');
        }
      } catch (err) {
        console.error('verify collector error:', err);
        try {
          if (i.replied || i.deferred) {
            await i.followUp({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
          } else {
            await i.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
          }
        } catch {}
      }
    });

    collector.on('end', async (_, reason) => {
      if (reason === 'done') return;
      try {
        await interaction.editReply({
          content: '⏰ Verification timed out. Click **Start Verification** again.',
          components: [],
        }).catch(() => {});
      } catch {}
    });
  },
};
