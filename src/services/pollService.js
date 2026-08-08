import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { logger } from '../utils/logger.js';

const ACTIVE_KEY = 'polls:active';

function pollKey(pollId) {
  return `poll:${pollId}`;
}

export async function savePoll(client, poll) {
  await client.db.set(pollKey(poll.id), poll);
  const active = (await client.db.get(ACTIVE_KEY, [])) || [];
  if (!active.includes(poll.id)) {
    active.push(poll.id);
    await client.db.set(ACTIVE_KEY, active);
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

export function buildPollEmbed(poll, { final = false } = {}) {
  const total = poll.options.reduce((s, o) => s + (o.votes?.length || 0), 0);
  const lines = poll.options.map((o, i) => {
    const n = o.votes?.length || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const bar =
      final || poll.showCounts
        ? ` — **${n}** vote${n === 1 ? '' : 's'} (${pct}%)`
        : '';
    return `**${i + 1}.** ${o.label}${bar}`;
  });

  let winnerLine = '';
  if (final) {
    const max = Math.max(...poll.options.map((o) => o.votes?.length || 0), 0);
    const winners = poll.options.filter((o) => (o.votes?.length || 0) === max);
    if (max === 0) winnerLine = '\n\n**Result:** No votes.';
    else if (winners.length === 1)
      winnerLine = `\n\n🏆 **Winner:** ${winners[0].label} (${max} vote${max === 1 ? '' : 's'})`;
    else
      winnerLine = `\n\n🤝 **Tie:** ${winners.map((w) => w.label).join(', ')} (${max} each)`;
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
        .setLabel(o.label.slice(0, 80))
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

  try {
    const channel = await client.channels.fetch(poll.channelId).catch(() => null);
    if (!channel?.isTextBased?.()) return poll;

    const embed = buildPollEmbed(poll, { final: true });
    const components = buildPollButtons(poll, true);

    if (poll.messageId) {
      const msg = await channel.messages.fetch(poll.messageId).catch(() => null);
      if (msg) await msg.edit({ embeds: [embed], components }).catch(() => {});
      else await channel.send({ embeds: [embed], components }).catch(() => {});
    } else {
      await channel.send({ embeds: [embed], components }).catch(() => {});
    }
  } catch (e) {
    logger.error('endPoll failed:', e?.message || e);
  }
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
