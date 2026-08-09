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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  category: 'fun',

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const minLevel = interaction.options.getInteger('min_level');
    const ageRole = interaction.options.getRole('min_age_range');
    const rankRole = interaction.options.getRole('min_rank');
    const extraRole = interaction.options.getRole('required_role');

    const meta = [
      channel.id,
      minLevel == null ? '' : String(minLevel),
      ageRole?.id || '',
      rankRole?.id || '',
      extraRole?.id || '',
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
          .setLabel('Duration (10s–30d) e.g. 30m 2h 1d')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(10),
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
  const m = String(str || '')
    .trim()
    .match(/^(\d+)\s*([smhd])$/i);
  if (!m) throw new Error('Use duration like 30m, 2h, 1d, or 45s');
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[u];
  const ms = n * mult;
  if (ms < 10_000) throw new Error('Minimum duration is 10 seconds');
  if (ms > 30 * 86_400_000) throw new Error('Maximum duration is 30 days');
  return ms;
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
    await channel.send(`Giveaway **${g.prize}** ended — no valid entries.`).catch(() => {});
  } else {
    await channel
      .send({
        content: `🎉 Congratulations ${pick.map((x) => `<@${x}>`).join(', ')}!\nYou won: **${g.prize}**`,
      })
      .catch(() => {});
  }
  return g;
}
