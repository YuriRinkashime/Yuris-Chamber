import { MessageFlags } from 'discord.js';
import { randomBytes } from 'crypto';
import {
  buildPollMessagePayload,
  savePoll,
  upsertOwnerPollCard,
} from '../../services/pollService.js';

function parseDuration(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return NaN;
  if (/^\d+\s*s(ec(ond)?s?)?$/.test(s)) return parseInt(s, 10);
  if (/^\d+\s*m(in(ute)?s?)?$/.test(s)) return parseInt(s, 10) * 60;
  if (/^\d+\s*h(our)?s?$/.test(s)) return parseInt(s, 10) * 3600;
  if (/^\d+\s*d(ay)?s?$/.test(s)) return parseInt(s, 10) * 86400;
  if (/^\d+:\d+$/.test(s)) {
    const [a, b] = s.split(':').map(Number);
    return a * 60 + b;
  }
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 60;
  // 2m30s
  let total = 0;
  const m = s.match(/(\d+)\s*m/);
  const sec = s.match(/(\d+)\s*s/);
  const h = s.match(/(\d+)\s*h/);
  const d = s.match(/(\d+)\s*d/);
  if (d) total += parseInt(d[1], 10) * 86400;
  if (h) total += parseInt(h[1], 10) * 3600;
  if (m) total += parseInt(m[1], 10) * 60;
  if (sec) total += parseInt(sec[1], 10);
  return total || NaN;
}

function parseSettings(raw) {
  // e.g. "votes=yes style=embed tie=random"
  const out = { showCounts: false, displayStyle: 'embed', tieBreak: 'keep' };
  const s = String(raw || '').toLowerCase();
  if (/votes\s*=\s*(yes|true|1|on|live)/.test(s) || s.includes('show votes')) out.showCounts = true;
  if (/votes\s*=\s*(no|false|0|off|hide)/.test(s)) out.showCounts = false;
  if (/style\s*=\s*text/.test(s)) out.displayStyle = 'text';
  else if (/style\s*=\s*both/.test(s)) out.displayStyle = 'both';
  else if (/style\s*=\s*embed|style\s*=\s*card/.test(s)) out.displayStyle = 'embed';
  if (/tie\s*=\s*(random|gamble|50\/50)/.test(s)) out.tieBreak = 'random';
  else if (/tie\s*=\s*keep|tie\s*=\s*show/.test(s)) out.tieBreak = 'keep';
  return out;
}

export default {
  name: 'poll_modal',

  async execute(interaction) {
    // customId: poll_modal:channelId|showCounts|style|tie  OR poll_modal:channelId
    const parts = interaction.customId.split(':');
    const meta = (parts[1] || '').split('|');
    const channelId = meta[0] || interaction.channelId;
    const fromSlash = {
      showCounts: meta[1] === '1' || meta[1] === 'true',
      displayStyle: meta[2] || 'embed',
      tieBreak: meta[3] || 'keep',
    };

    const question = interaction.fields.getTextInputValue('question').trim();
    const rawOptions = interaction.fields.getTextInputValue('options');
    const durationRaw = interaction.fields.getTextInputValue('minutes'); // duration field
    let settingsRaw = '';
    try {
      settingsRaw = interaction.fields.getTextInputValue('settings') || '';
    } catch (_) {}

    const parsed = parseSettings(settingsRaw);
    const showCounts = settingsRaw ? parsed.showCounts : fromSlash.showCounts;
    const displayStyle = settingsRaw ? parsed.displayStyle : fromSlash.displayStyle || 'embed';
    const tieBreak = settingsRaw ? parsed.tieBreak : fromSlash.tieBreak || 'keep';

    const totalSec = parseDuration(durationRaw);
    if (!Number.isFinite(totalSec) || totalSec < 10 || totalSec > 10080 * 60) {
      return interaction.reply({
        content:
          'Duration invalid. Examples: `5` (5 min), `90s`, `2h`, `1d`, `2m30s`',
        flags: MessageFlags.Ephemeral,
      });
    }

    const labels = rawOptions
      .split(/\r?\n|\|/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);

    if (labels.length < 2) {
      return interaction.reply({
        content: 'Need **at least 2** options (one per line).',
        flags: MessageFlags.Ephemeral,
      });
    }

    const channel =
      interaction.guild.channels.cache.get(channelId) ||
      (await interaction.guild.channels.fetch(channelId).catch(() => null));

    if (!channel?.isTextBased?.()) {
      return interaction.reply({
        content: 'Could not find that channel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const options = labels.map((label, i) => ({
      id: i,
      label: label.slice(0, 80),
      votes: [],
    }));

    const pollId = randomBytes(6).toString('hex');
    const endsAt = Date.now() + totalSec * 1000;

    const poll = {
      id: pollId,
      guildId: interaction.guildId,
      channelId: channel.id,
      messageId: null,
      question,
      options,
      endsAt,
      ended: false,
      showCounts: !!showCounts,
      displayStyle: ['text', 'embed', 'both'].includes(displayStyle) ? displayStyle : 'embed',
      tieBreak: tieBreak === 'random' || tieBreak === 'gamble' ? 'random' : 'keep',
      createdBy: interaction.user.id,
      createdAt: Date.now(),
      ownerNotify: {},
    };

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const msg = await channel.send(buildPollMessagePayload(poll));
      poll.messageId = msg.id;
      await savePoll(interaction.client, poll);
      await upsertOwnerPollCard(interaction.client, poll, {
        note: 'New poll created',
      }).catch(() => {});

      return interaction.editReply({
        content:
          `✅ Poll posted in ${channel}\n` +
          `**${question}** · ${options.length} options\n` +
          `Style: **${poll.displayStyle}** · Live votes: **${poll.showCounts ? 'yes' : 'no'}** · Tie: **${poll.tieBreak}**\n` +
          `Ends <t:${Math.floor(endsAt / 1000)}:R>`,
      });
    } catch (e) {
      return interaction.editReply({
        content: `Failed to post poll: ${e.message || e}`,
      });
    }
  },
};
