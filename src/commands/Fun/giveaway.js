import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ChannelType,
} from 'discord.js';

function parseDuration(str) {
  const m = String(str || '')
    .trim()
    .match(/^(\d+)([smhd])$/i);
  if (!m) throw new Error('Duration: use 30m, 1h, 1d, etc.');
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[u];
  const ms = n * mult;
  if (ms < 10000 || ms > 30 * 86400000) throw new Error('Duration 10s–30d');
  return ms;
}

export default {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Start a customized giveaway')
    .addStringOption((o) =>
      o.setName('prize').setDescription('Prize').setRequired(true).setMaxLength(200),
    )
    .addStringOption((o) =>
      o
        .setName('duration')
        .setDescription('e.g. 30m, 2h, 1d')
        .setRequired(true),
    )
    .addIntegerOption((o) =>
      o
        .setName('winners')
        .setDescription('Number of winners')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(20),
    )
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Channel (default: here)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addIntegerOption((o) =>
      o
        .setName('min_level')
        .setDescription('Minimum level (optional)')
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(1000),
    )
    .addRoleOption((o) =>
      o
        .setName('required_rank')
        .setDescription('Required rank/role (optional)')
        .setRequired(false),
    )
    .addRoleOption((o) =>
      o
        .setName('required_age')
        .setDescription('Required age role e.g. 18-23 (optional)')
        .setRequired(false),
    )
    .addRoleOption((o) =>
      o
        .setName('required_role')
        .setDescription('Any extra required role (optional)')
        .setRequired(false),
    )
    .addStringOption((o) =>
      o
        .setName('description')
        .setDescription('Extra text on the embed')
        .setRequired(false)
        .setMaxLength(500),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  category: 'fun',

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let durationMs;
    try {
      durationMs = parseDuration(interaction.options.getString('duration', true));
    } catch (e) {
      return interaction.editReply({ content: e.message });
    }

    const prize = interaction.options.getString('prize', true);
    const winners = interaction.options.getInteger('winners') || 1;
    const channel =
      interaction.options.getChannel('channel') || interaction.channel;
    const minLevel = interaction.options.getInteger('min_level');
    const rankRole = interaction.options.getRole('required_rank');
    const ageRole = interaction.options.getRole('required_age');
    const extraRole = interaction.options.getRole('required_role');
    const description = interaction.options.getString('description') || '';

    const endsAt = Date.now() + durationMs;
    const giveawayId = `${interaction.guildId}-${Date.now()}`;

    const reqLines = [];
    if (minLevel != null) reqLines.push(`📈 Level **${minLevel}+**`);
    if (rankRole) reqLines.push(`🎮 Rank ${rankRole}`);
    if (ageRole) reqLines.push(`🎂 Age ${ageRole}`);
    if (extraRole) reqLines.push(`🎭 Role ${extraRole}`);

    const embed = new EmbedBuilder()
      .setColor(0xc4a1ff)
      .setTitle('🎉 Giveaway')
      .setDescription(
        `**Prize:** ${prize}\n` +
          (description ? `${description}\n\n` : '') +
          `**Winners:** ${winners}\n` +
          `**Ends:** <t:${Math.floor(endsAt / 1000)}:R>\n` +
          (reqLines.length
            ? `\n**Requirements**\n${reqLines.join('\n')}`
            : '\n_No special requirements_') +
          `\n\nReact with the button to enter!`,
      )
      .setFooter({ text: `Hosted by ${interaction.user.tag} · ${giveawayId}` })
      .setTimestamp(endsAt);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gw_enter:${giveawayId}`)
        .setLabel('Enter')
        .setEmoji('🎉')
        .setStyle(ButtonStyle.Primary),
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });

    const record = {
      id: giveawayId,
      guildId: interaction.guildId,
      channelId: channel.id,
      messageId: msg.id,
      prize,
      winners,
      endsAt,
      hostId: interaction.user.id,
      entrants: [],
      ended: false,
      requirements: {
        minLevel: minLevel ?? null,
        rankRoleId: rankRole?.id || null,
        ageRoleId: ageRole?.id || null,
        extraRoleId: extraRole?.id || null,
      },
    };

    await interaction.client.db.set(`giveaway:${giveawayId}`, record);

    // schedule end (in-memory; survives until process restart — optional cron later)
    setTimeout(() => {
      endGiveaway(interaction.client, giveawayId).catch(() => {});
    }, durationMs);

    return interaction.editReply({
      content: `Giveaway posted in ${channel}.`,
    });
  },
};

export async function endGiveaway(client, giveawayId) {
  const key = `giveaway:${giveawayId}`;
  const g = await client.db.get(key, null);
  if (!g || g.ended) return;
  g.ended = true;
  await client.db.set(key, g);

  const channel = await client.channels.fetch(g.channelId).catch(() => null);
  if (!channel) return;

  const entrants = [...new Set(g.entrants || [])];
  const pick = [];
  const pool = [...entrants];
  while (pick.length < g.winners && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    pick.push(pool.splice(i, 1)[0]);
  }

  const msg = await channel.messages.fetch(g.messageId).catch(() => null);
  if (msg) {
    const embed = EmbedBuilder.from(msg.embeds[0] || {})
      .setColor(0x5ddea0)
      .setTitle('🎉 Giveaway ended');
    await msg.edit({
      embeds: [embed],
      components: [],
    }).catch(() => {});
  }

  if (!pick.length) {
    await channel.send(`Giveaway **${g.prize}** ended — no valid entries.`);
    return;
  }

  await channel.send({
    content:
      `🎉 Congratulations ${pick.map((id) => `<@${id}>`).join(', ')}!\n` +
      `You won: **${g.prize}**`,
  });
}
