import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';

const pending = (globalThis.__yuriVerifyPending ??= new Map());

const ROLE_MAP = {
  age_13_17: '13-17',
  age_18_23: '18-23',
  age_24: '24+',
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
    s.rank ? `**Rank:** ${s.rank}` : '**Rank:** —',
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
  {
    name: 'verify_age',
    async execute(interaction) {
      try {
        if (await blockIfVerified(interaction)) return;

        const age = ROLE_MAP[interaction.values?.[0]];
        if (!age) return safeError(interaction, 'Invalid age option.');

        setPending(interaction, { age, gender: null, rank: null });

        // Public panel click → private reply
        // Already inside private message (Back to age) → update that message
        const payload = {
          content:
            `✅ Age selected: **${age}**\n\n` +
            `**Step 2/3 — Choose your Gender**\n` +
            `(You can press **Back** to change age)`,
          components: [genderRow(), backButton('verify_back_age')],
        };

        if (interaction.replied || interaction.deferred || interaction.message?.flags?.has?.(64)) {
          // 64 = Ephemeral — already in private flow
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
          } else {
            await interaction.update(payload);
          }
        } else {
          await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
        }
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

        const gender = ROLE_MAP[interaction.values?.[0]];
        if (!gender) return safeError(interaction, 'Invalid gender option.');

        const state = setPending(interaction, { gender, rank: null });
        if (!state.age) {
          return safeError(interaction, 'Session expired. Use the channel panel again.');
        }

        await interaction.update({
          content:
            `${summary(state)}\n\n` +
            `**Step 3/3 — Choose your Valorant Rank**`,
          components: [rankRow(), backButton('verify_back_gender')],
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

        const rank = ROLE_MAP[interaction.values?.[0]];
        if (!rank) return safeError(interaction, 'Invalid rank option.');

        const state = setPending(interaction, { rank });
        if (!state.age || !state.gender) {
          return safeError(interaction, 'Session expired. Use the channel panel again.');
        }

        await interaction.update({
          content:
            `${summary(state)}\n\n` +
            `Review your choices, then press **Confirm**.\n` +
            `Or **Back** to change rank.`,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('verify_back_rank')
                .setLabel('Back')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('⬅️'),
              new ButtonBuilder()
                .setCustomId('verify_confirm')
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅'),
            ),
          ],
        });
      } catch (err) {
        await safeError(interaction, err.message || 'Something went wrong.');
      }
    },
  },
];
