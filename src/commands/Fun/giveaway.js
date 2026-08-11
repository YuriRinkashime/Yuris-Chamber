import { parseFlexibleDuration } from '../../utils/duration.js';
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Start a giveaway (opens a form)')
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Where to post (default: this channel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false),
    )
    .addIntegerOption((o) =>
      o
        .setName('min_level')
        .setDescription('Minimum level to enter')
        .setMinValue(0)
        .setMaxValue(1000)
        .setRequired(false),
    )
    .addRoleOption((o) =>
      o
        .setName('min_age_range')
        .setDescription('Required age-range role (e.g. 18-23)')
        .setRequired(false),
    )
    .addRoleOption((o) =>
      o
        .setName('min_rank')
        .setDescription('Required rank role')
        .setRequired(false),
    )
    .addRoleOption((o) =>
      o
        .setName('required_role')
        .setDescription('Any extra required role')
        .setRequired(false),
    )
    .addRoleOption((o) =>
      o
        .setName('mention_role')
        .setDescription('Ping a role when the giveaway is posted')
        .setRequired(false),
    )
    .addUserOption((o) =>
      o
        .setName('mention_user')
        .setDescription('Ping a user when the giveaway is posted')
        .setRequired(false),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  category: 'fun',

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const minLevel = interaction.options.getInteger('min_level');
    const ageRole = interaction.options.getRole('min_age_range');
    const rankRole = interaction.options.getRole('min_rank');
    const extraRole = interaction.options.getRole('required_role');
    const mentionRole = interaction.options.getRole('mention_role');
    const mentionUser = interaction.options.getUser('mention_user');

    const meta = [
      channel.id,
      minLevel == null ? '' : String(minLevel),
      ageRole?.id || '',
      rankRole?.id || '',
      extraRole?.id || '',
      mentionRole?.id || '',
      mentionUser?.id || '',
    ].join('|');

    const modal = new ModalBuilder()
      .setCustomId(`giveaway_modal:${meta}`)
      .setTitle('Create giveaway');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('prize')
          .setLabel('Prize')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('duration')
          .setLabel('Duration e.g. 2h / 1d / 1w / 1mo / 1y')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('winners')
          .setLabel('Number of winners')
          .setStyle(TextInputStyle.Short)
          .setValue('1')
          .setRequired(true)
          .setMaxLength(2),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('description')
          .setLabel('Extra description (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ),
    );

    await interaction.showModal(modal);
  },
};

export function parseDuration(str) {
  // Supports 30s, 5m, 2h, 1d, 1w, 2mo, 1y, 1d12h — max 1 year
  return parseFlexibleDuration(str, {
    minMs: 10_000,
    maxMs: 365 * 86_400_000,
  });
}

export async function endSimpleGiveaway(client, giveawayId) {
  const key = giveawayId.startsWith('giveaway:') ? giveawayId : `giveaway:${giveawayId}`;
  const id = key.replace(/^giveaway:/, '');
  const g = await client.db.get(key, null);
  if (!g || g.ended) return g;
  g.ended = true;
  g.isEnded = true;
  g.paused = false;
  g.endedAt = new Date().toISOString();

  const entrants = [...new Set(g.entrants || g.participants || [])];
  const winnersCount = g.winners || g.winnerCount || 1;
  const pick = [];
  const pool = [...entrants];
  while (pick.length < winnersCount && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    pick.push(pool.splice(i, 1)[0]);
  }
  g.winnerIds = pick;
  g.id = g.id || id;
  await client.db.set(key, g);

  const channel = await client.channels.fetch(g.channelId).catch(() => null);
  if (!channel) return g;

  const msg = await channel.messages.fetch(g.messageId).catch(() => null);
  if (msg) {
    const embed = EmbedBuilder.from(msg.embeds[0] || {})
      .setColor(0x5ddea0)
      .setTitle('🎉 Giveaway ended')
      .setDescription(
        `**Prize:** ${g.prize}\n**Winners:** ${
          pick.length ? pick.map((x) => `<@${x}>`).join(', ') : '_No valid entries_'
        }\n**Entries:** ${entrants.length}`,
      );
    await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
  }

  if (!pick.length) {
    const m = await channel.send(`Giveaway **${g.prize}** ended — no valid entries.`).catch(() => null);
    if (m) {
      g.winnerMessageId = m.id;
      await client.db.set(key, g);
    }
  } else {
    const m = await channel
      .send({
        content: `🎉 Congratulations ${pick.map((x) => `<@${x}>`).join(', ')}!\nYou won: **${g.prize}**`,
      })
      .catch(() => null);
    if (m) {
      g.winnerMessageId = m.id;
      await client.db.set(key, g);
    }
  }
  return g;
}
