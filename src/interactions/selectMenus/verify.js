import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { getVerifyConfig, buildRoleMap } from '../../services/verifyConfig.js';

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
  setTimeout(() => {
    if (pending.get(key) === next) pending.delete(key);
  }, 15 * 60 * 1000).unref?.();
  return next;
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

function confirmRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify_confirm').setLabel('Confirm').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId('verify_back_rank').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('◀️'),
  );
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
    name: 'verify_age',
    async execute(interaction) {
      try {
        if (await blockIfVerified(interaction)) return;
        const cfg = await getVerifyConfig(interaction.client, interaction.guildId);
        const map = buildRoleMap(cfg);
        const roleName = map[interaction.values[0]];
        if (!roleName) return safeError(interaction, 'Unknown age option.');
        setPending(interaction, { age: roleName, gender: null, rank: null });
        await interaction.update({
          content: `✅ Age: **${roleName}**\n\n**Step 2/3 — Gender**`,
          components: [
            selectRow('verify_gender', 'Select your gender...', cfg.genders),
            backButton('verify_back_age'),
          ],
        });
      } catch (err) {
        await safeError(interaction, err.message || 'Something went wrong.');
      }
    },
  },
  {
    name: 'verify_gender',
    async execute(interaction) {
      try {
        if (await blockIfVerified(interaction)) return;
        const cfg = await getVerifyConfig(interaction.client, interaction.guildId);
        const map = buildRoleMap(cfg);
        const roleName = map[interaction.values[0]];
        if (!roleName) return safeError(interaction, 'Unknown gender option.');
        const state = setPending(interaction, { gender: roleName, rank: null });
        if (!state.age) return safeError(interaction, 'Session expired. Use the panel again.');
        await interaction.update({
          content: `${summary(state)}\n\n**Step 3/3 — Rank / activity**\n_Valorant rank, Unranked, or other games_`,
          components: [
            selectRow('verify_rank', 'Rank or activity...', cfg.ranks),
            backButton('verify_back_gender'),
          ],
        });
      } catch (err) {
        await safeError(interaction, err.message || 'Something went wrong.');
      }
    },
  },
  {
    name: 'verify_rank',
    async execute(interaction) {
      try {
        if (await blockIfVerified(interaction)) return;
        const cfg = await getVerifyConfig(interaction.client, interaction.guildId);
        const map = buildRoleMap(cfg);
        const roleName = map[interaction.values[0]];
        if (!roleName) return safeError(interaction, 'Unknown rank option.');
        const state = setPending(interaction, { rank: roleName });
        if (!state.age || !state.gender) return safeError(interaction, 'Session expired.');
        await interaction.update({
          content: `${summary(state)}\n\nConfirm to receive your roles.`,
          components: [confirmRow()],
        });
      } catch (err) {
        await safeError(interaction, err.message || 'Something went wrong.');
      }
    },
  },
];
