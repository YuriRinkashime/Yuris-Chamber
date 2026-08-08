import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { logger } from '../utils/logger.js';

const ACTIVE_KEY = 'polls:active';
const ENDED_KEY = 'polls:ended';

function pollKey(pollId) {
  return `poll:${pollId}`;
}

export function getPollStats(poll) {
  const options = (poll?.options || []).map((o) => ({
    label: o.label,
    votes: (o.votes || []).length,
  }));
  const total = options.reduce((s, o) => s + o.votes, 0);
  const max = Math.max(0, ...options.map((o) => o.votes));
  const winners =
    max === 0 ? [] : options.filter((o) => o.votes === max).map((o) => o.label);
  return { options, total, max, winners };
}

export async function savePoll(client, poll) {
  await client.db.set(pollKey(poll.id), poll);
  if (!poll.ended) {
    const active = (await client.db.get(ACTIVE_KEY, [])) || [];
    if (!active.includes(poll.id)) {
      active.push(poll.id);
      await client.db.set(ACTIVE_KEY, active);
    }
  }
}

export async function getPoll(client, pollId) {
  return (await client.db.get(pollKey(pollId), null)) || null;
}

export async function removeActive(client, pollId) {
  const active = (await client.db.get(ACTIVE_KEY, [])) || [];
  await client.db.set(
    ACTIVE_KEY,
    active.filter((id) => id !== pollId),
  );
}

async function pushEnded(client, pollId) {
  let ended = (await client.db.get(ENDED_KEY, [])) || [];
  ended = [pollId, ...ended.filter((id) => id !== pollId)].slice(0, 80);
  await client.db.set(ENDED_KEY, ended);
}

export async function listActivePolls(client) {
  const ids = (await client.db.get(ACTIVE_KEY, [])) || [];
  const out = [];
  for (const id of ids) {
    const p = await getPoll(client, id);
    if (p && !p.ended) out.push(p);
  }
  return out.sort((a, b) => (a.endsAt || 0) - (b.endsAt || 0));
}

export async function listEndedPolls(client) {
  const ids = (await client.db.get(ENDED_KEY, [])) || [];
  const out = [];
  for (const id of ids) {
    const p = await getPoll(client, id);
    if (p) out.push(p);
  }
  return out.sort((a, b) => (b.endedAt || b.endsAt || 0) - (a.endedAt || a.endsAt || 0));
}

function ownerIds() {
  const raw = process.env.OWNER_IDS || process.env.OWNER_ID || '';
  return String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** DM all bot owners about a poll event */
export async function notifyOwnersPoll(client, text) {
  const ids = ownerIds();
  if (!ids.length || !client?.users) return;
  for (const id of ids) {
    try {
      const u = await client.users.fetch(id).catch(() => null);
      if (u) await u.send({ content: text.slice(0, 2000) }).catch(() => {});
    } catch (_) {}
  }
}

export function buildPollEmbed(poll, { final = false } = {}) {
  const { options, total, winners, max } = getPollStats(poll);
  const lines = options.map((o, i) => {
    const pct = total ? Math.round((o.votes / total) * 100) : 0;
    const bar =
      final || poll.showCounts
        ? ` — **${o.votes}** vote${o.votes === 1 ? '' : 's'} (${pct}%)`
        : '';
    return `**${i + 1}.** ${o.label}${bar}`;
  });

  let winnerLine = '';
  if (final) {
    if (max === 0) winnerLine = '\n\n**Result:** No votes.';
    else if (winners.length === 1)
      winnerLine = `\n\n🏆 **Winner:** ${winners[0]} (${max} vote${max === 1 ? '' : 's'})`;
    else winnerLine = `\n\n🤝 **Tie:** ${winners.join(', ')} (${max} each)`;
  }

  const ends = poll.endsAt ? `<t:${Math.floor(poll.endsAt / 1000)}:R>` : '—';

  return new EmbedBuilder()
    .setColor(final ? 0x0fdda3 : 0xff4655)
    .setTitle(final ? `Poll ended · ${poll.question}` : `📊 ${poll.question}`)
    .setDescription(lines.join('\n') + winnerLine)
    .addFields(
      { name: 'Status', value: final ? 'Closed' : `Ends ${ends}`, inline: true },
      { name: 'Total votes', value: String(total), inline: true },
    )
    .setFooter({
      text: final
        ? 'Poll closed'
        : 'Click a button to vote · one choice per person',
    })
    .setTimestamp(final ? new Date() : new Date(poll.endsAt));
}

export function buildPollButtons(poll, disabled = false) {
  const rows = [];
  let row = new ActionRowBuilder();
  poll.options.forEach((o, i) => {
    if (i > 0 && i % 5 === 0) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`poll_vote:${poll.id}:${i}`)
        .setLabel(String(o.label).slice(0, 80))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    );
  });
  if (row.components.length) rows.push(row);
  return rows;
}

export async function endPoll(client, poll) {
  if (!poll || poll.ended) return poll;

  poll.ended = true;
  poll.endedAt = Date.now();
  poll.showCounts = true;
  await client.db.set(pollKey(poll.id), poll);
  await removeActive(client, poll.id);
  await pushEnded(client, poll.id);

  try {
    const channel = await client.channels.fetch(poll.channelId).catch(() => null);
    if (channel?.isTextBased?.()) {
      const embed = buildPollEmbed(poll, { final: true });
      const components = buildPollButtons(poll, true);
      if (poll.messageId) {
        const msg = await channel.messages.fetch(poll.messageId).catch(() => null);
        if (msg) await msg.edit({ embeds: [embed], components }).catch(() => {});
        else await channel.send({ embeds: [embed], components }).catch(() => {});
      } else {
        await channel.send({ embeds: [embed], components }).catch(() => {});
      }
    }
  } catch (e) {
    logger.error('endPoll failed:', e?.message || e);
  }

  const { total, winners, max } = getPollStats(poll);
  const winText =
    max === 0
      ? 'No votes'
      : winners.length === 1
        ? `Winner: **${winners[0]}** (${max})`
        : `Tie: **${winners.join(', ')}** (${max} each)`;

  await notifyOwnersPoll(
    client,
    `📊 **Poll ended**\n**${poll.question}**\nTotal votes: **${total}**\n${winText}\nChannel: <#${poll.channelId}>`,
  );

  return poll;
}

export async function checkPolls(client) {
  if (!client?.db) return;
  try {
    const active = (await client.db.get(ACTIVE_KEY, [])) || [];
    if (!active.length) return;
    const now = Date.now();
    for (const id of [...active]) {
      const poll = await getPoll(client, id);
      if (!poll || poll.ended) {
        await removeActive(client, id);
        if (poll?.ended) await pushEnded(client, id);
        continue;
      }
      if (poll.endsAt && now >= poll.endsAt) {
        await endPoll(client, poll);
      }
    }
  } catch (e) {
    logger.error('checkPolls:', e?.message || e);
  }
}
