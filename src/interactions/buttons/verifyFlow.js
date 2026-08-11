import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags } from 'discord.js';

const pending = (globalThis.__yuriVerifyPending ??= new Map());

const AGE_ROLES = ['13-17', '18-23', '24+'];
const GENDER_ROLES = ['Male', 'Female', 'Non-binary / Other'];
const RANK_ROLES = [
  'Iron', 'Bronze', 'Silver', 'Gold', 'Platinum',
  'Diamond', 'Ascendant', 'Immortal', 'Radiant',
  'Unranked', "Doesn't Play Valo",
];

function keyOf(i) {
  return `${i.guildId}:${i.user.id}`;
}
function getPending(i) {
  return pending.get(keyOf(i)) || {};
}
function setPending(i, data) {
  const key = keyOf(i);
  const next = { ...getPending(i), ...data };
  pending.set(key, next);
  return next;
}
function clearPending(i) {
  pending.delete(keyOf(i));
}
function summary(s) {
  return [
    s.age ? `**Age:** ${s.age}` : '**Age:** —',
    s.gender ? `**Gender:** ${s.gender}` : '**Gender:** —',
    s.rank ? `**Rank / status:** ${s.rank}` : '**Rank / status:** —',
  ].join('\n');
}

function alreadyVerified(member) {
  return member.roles.cache.some((r) => r.name === 'Verified');
}

async function blockIfVerified(interaction) {
  if (alreadyVerified(interaction.member)) {
    const payload = {
      content: '❌ You are **already verified**. You cannot use this panel again.',
      flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
    return true;
  }
  return false;
}

function ageRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('verify_age')
      .setPlaceholder('Select your age...')
      .addOptions(
        { label: '13-17', value: 'age_13_17', emoji: '🟢' },
        { label: '18-23', value: 'age_18_23', emoji: '🟡' },
        { label: '24+', value: 'age_24', emoji: '🔴' },
      ),
  );
}

function genderRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('verify_gender')
      .setPlaceholder('Select your gender...')
      .addOptions(
        { label: 'Male', value: 'gender_male', emoji: '♂️' },
        { label: 'Female', value: 'gender_female', emoji: '♀️' },
        { label: 'Non-binary / Other', value: 'gender_other', emoji: '🌈' },
      ),
  );
}

function rankRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('verify_rank')
      .setPlaceholder('Rank or activity (Valo / other)...')
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
        { label: 'Unranked', value: 'rank_unranked', emoji: '❔' },
        {
          label: "Doesn't Play Valo",
          value: 'rank_no_valo',
          emoji: '🎮',
          description: 'Here for other games / hangout',
        },
      ),
  );
}

function backButton(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(id)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⬅️'),
  );
}

async function assignRole(member, roleName, groupNames) {
  const guild = member.guild;
  const me = guild.members.me;
  if (!me?.permissions.has('ManageRoles')) {
    throw new Error('I need the **Manage Roles** permission.');
  }
  const role = guild.roles.cache.find((r) => r.name === roleName);
  if (!role) throw new Error(`Role **"${roleName}"** not found.`);
  if (role.managed) throw new Error(`Role **"${roleName}"** is managed.`);
  if (role.position >= me.roles.highest.position) {
    throw new Error(`My role is below **"${roleName}"**. Move it higher.`);
  }
  const toRemove = member.roles.cache.filter(
    (r) => groupNames.includes(r.name) && r.id !== role.id,
  );
  if (toRemove.size > 0) await member.roles.remove(toRemove);
  await member.roles.add(role);
}

async function safeError(interaction, message) {
  const payload = { content: `❌ ${message}`, flags: MessageFlags.Ephemeral };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch {}
}

export default [
  // Back → choose age again (private)
  {
    name: 'verify_back_age',
    async execute(interaction) {
      try {
        if (await blockIfVerified(interaction)) return;

        setPending(interaction, { age: null, gender: null, rank: null });

        await interaction.update({
          content:
            `**Step 1/3 — Choose your Age**\n` +
            `Pick again below.`,
          components: [ageRow()] });
      } catch (err) {
        await safeError(interaction, err.message || 'Something went wrong.');
      }
    } },

  // Back → gender
  {
    name: 'verify_back_gender',
    async execute(interaction) {
      try {
        if (await blockIfVerified(interaction)) return;

        const state = setPending(interaction, { gender: null, rank: null });
        if (!state.age) {
          return safeError(interaction, 'Session expired. Use the channel panel again.');
        }

        await interaction.update({
          content:
            `✅ Age selected: **${state.age}**\n\n` +
            `**Step 2/3 — Choose your Gender**`,
          components: [genderRow(), backButton('verify_back_age')] });
      } catch (err) {
        await safeError(interaction, err.message || 'Something went wrong.');
      }
    } },

  // Back → rank
  {
    name: 'verify_back_rank',
    async execute(interaction) {
      try {
        if (await blockIfVerified(interaction)) return;

        const state = setPending(interaction, { rank: null });
        if (!state.age || !state.gender) {
          return safeError(interaction, 'Session expired. Use the channel panel again.');
        }

        await interaction.update({
          content: `${summary(state)}\n\n**Step 3/3 — Rank / activity** (Valorant, Unranked, or Doesn't Play Valo)`,
          components: [rankRow(), backButton('verify_back_gender')] });
      } catch (err) {
        await safeError(interaction, err.message || 'Something went wrong.');
      }
    } },

  // Confirm → give all roles
  {
    name: 'verify_confirm',
    async execute(interaction) {
      try {
        if (await blockIfVerified(interaction)) return;

        const state = getPending(interaction);
        if (!state.age || !state.gender || !state.rank) {
          return safeError(interaction, 'Session expired. Use the channel panel again.');
        }

        await interaction.deferUpdate();

        const member = interaction.member;
        await assignRole(member, state.age, AGE_ROLES);
        await assignRole(member, state.gender, GENDER_ROLES);
        await assignRole(member, state.rank, RANK_ROLES);

        const verifiedRole = interaction.guild.roles.cache.find(
          (r) => r.name === 'Verified',
        );
        if (verifiedRole) {
          const me = interaction.guild.members.me;
          if (
            me?.permissions.has('ManageRoles') &&
            verifiedRole.position < me.roles.highest.position &&
            !verifiedRole.managed
          ) {
            await member.roles.add(verifiedRole).catch(() => {});
          }
        }

        clearPending(interaction);

        await interaction.editReply({
          content:
            `🎉 **You are verified!**\n\n${summary(state)}\n\n` +
            `All roles applied. Welcome to BANORANT!`,
          components: [] });

        await interaction.followUp({
          content:
            '🎂 **Tip:** Use `/birthday set` with your birth year, month, and day.\n' +
            'We can greet you on your birthday and auto-update your age role (13-17 → 18-23 → 24+).',
          flags: MessageFlags.Ephemeral }).catch(() => {});
        
      } catch (err) {
        await safeError(interaction, err.message || 'Something went wrong.');
      }
    } },
];
