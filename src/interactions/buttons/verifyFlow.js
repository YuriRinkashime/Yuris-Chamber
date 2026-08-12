import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { getVerifyConfig } from '../../services/verifyConfig.js';

const pending = (globalThis.__yuriVerifyPending ??= new Map());

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
      content: '❌ You are **already verified**.',
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
    return true;
  }
  return false;
}
function selectRow(customId, placeholder, options) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions(
        options.map((o) => ({
          label: o.label.slice(0, 100),
          value: o.value,
          emoji: o.emoji || undefined,
          description: o.description ? String(o.description).slice(0, 100) : undefined,
        })),
      ),
  );
}
function backButton(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(id).setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('◀️'),
  );
}
async function assignRole(member, roleName, allowedNames) {
  if (!roleName) return;
  const guild = member.guild;
  const me = guild.members.me;
  if (!me?.permissions.has('ManageRoles')) throw new Error('I need **Manage Roles**.');
  let role = guild.roles.cache.find((r) => r.name === roleName);
  if (!role) {
    role = await guild.roles.create({ name: roleName, reason: 'Verification auto-create' }).catch(() => null);
  }
  if (!role) throw new Error(`Could not find/create role **${roleName}**.`);
  if (role.managed) throw new Error(`Role **"${roleName}"** is managed.`);
  if (role.position >= me.roles.highest.position) {
    throw new Error(`Move my role **above** **${roleName}**.`);
  }
  const remove = member.roles.cache.filter((r) => allowedNames.includes(r.name) && r.id !== role.id);
  if (remove.size) await member.roles.remove(remove).catch(() => {});
  if (!member.roles.cache.has(role.id)) await member.roles.add(role);
}
async function safeError(interaction, message) {
  const payload = { content: `❌ ${message}`, flags: MessageFlags.Ephemeral };
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch (_) {}
}

export default [
  {
    name: 'verify_back_age',
    async execute(interaction) {
      try {
        if (await blockIfVerified(interaction)) return;
        const cfg = await getVerifyConfig(interaction.client, interaction.guildId);
        setPending(interaction, { age: null, gender: null, rank: null });
        await interaction.update({
          content: '**Step 1/3 — Age**\n_Only you see this. The channel panel stays for everyone._',
          components: [selectRow('verify_age', 'Select your age...', cfg.ages)],
        });
      } catch (err) {
        await safeError(interaction, err.message || 'Error');
      }
    },
  },
  {
    name: 'verify_back_gender',
    async execute(interaction) {
      try {
        if (await blockIfVerified(interaction)) return;
        const cfg = await getVerifyConfig(interaction.client, interaction.guildId);
        const state = setPending(interaction, { gender: null, rank: null });
        if (!state.age) return safeError(interaction, 'Session expired.');
        await interaction.update({
          content: `✅ Age: **${state.age}**\n\n**Step 2/3 — Gender**`,
          components: [
            selectRow('verify_gender', 'Select your gender...', cfg.genders),
            backButton('verify_back_age'),
          ],
        });
      } catch (err) {
        await safeError(interaction, err.message || 'Error');
      }
    },
  },
  {
    name: 'verify_back_rank',
    async execute(interaction) {
      try {
        if (await blockIfVerified(interaction)) return;
        const cfg = await getVerifyConfig(interaction.client, interaction.guildId);
        const state = setPending(interaction, { rank: null });
        if (!state.age || !state.gender) return safeError(interaction, 'Session expired.');
        await interaction.update({
          content: `${summary(state)}\n\n**Step 3/3 — Rank / activity**`,
          components: [
            selectRow('verify_rank', 'Rank or activity...', cfg.ranks),
            backButton('verify_back_gender'),
          ],
        });
      } catch (err) {
        await safeError(interaction, err.message || 'Error');
      }
    },
  },
  {
    name: 'verify_confirm',
    async execute(interaction) {
      try {
        if (await blockIfVerified(interaction)) return;
        const state = getPending(interaction);
        if (!state.age || !state.gender || !state.rank) {
          return safeError(interaction, 'Session expired. Use the panel again.');
        }
        const cfg = await getVerifyConfig(interaction.client, interaction.guildId);
        await interaction.deferUpdate();
        const member = interaction.member;
        await assignRole(member, state.age, cfg.ages.map((a) => a.roleName));
        await assignRole(member, state.gender, cfg.genders.map((g) => g.roleName));
        await assignRole(member, state.rank, cfg.ranks.map((r) => r.roleName));
        const verifiedRole = interaction.guild.roles.cache.find((r) => r.name === 'Verified');
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
          content: `🎉 **You are verified!**\n\n${summary(state)}\n\nWelcome to **BANORANT CAFE** 🎮`,
          components: [],
        });
        await interaction
          .followUp({
            content: '🎂 Tip: `/birthday set` for birthday greetings & age role updates.',
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      } catch (err) {
        await safeError(interaction, err.message || 'Error');
      }
    },
  },
];
