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

function bar(pct, width = 10) {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
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

async function removeEnded(client, pollId) {
  const ended = (await client.db.get(ENDED_KEY, [])) || [];
  await client.db.set(
    ENDED_KEY,
    ended.filter((id) => id !== pollId),
  );
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
  return out.sort(
    (a, b) => (b.endedAt || b.endsAt || 0) - (a.endedAt || a.endsAt || 0),
  );
}

function ownerIds() {
  const raw = process.env.OWNER_IDS || process.env.OWNER_ID || '';
  return String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildOwnerPollCard(poll, { note = null } = {}) {
  const { options, total, winners, max } = getPollStats(poll);
  const lines = options.map((o, i) => {
    const pct = total ? Math.round((o.votes / total) * 100) : 0;
    return `**${i + 1}.** ${o.label}\n\`${bar(pct)}\` **${o.votes}** (${pct}%)`;
  });

  let result = '';
  if (poll.ended) {
    if (max === 0) result = '\n\n**Result:** No votes.';
    else if (winners.length === 1)
      result = `\n\n🏆 **Winner:** ${winners[0]} (${max})`;
    else result = `\n\n🤝 **Tie:** ${winners.join(', ')} (${max} each)`;
  }

  const status = poll.ended
    ? 'Ended'
    : poll.endsAt
      ? `Ends <t:${Math.floor(poll.endsAt / 1000)}:R> (<t:${Math.floor(poll.endsAt / 1000)}:f>)`
      : '—';

  return new EmbedBuilder()
    .setColor(poll.ended ? 0x0fdda3 : 0xff4655)
    .setTitle(
      poll.ended
        ? `📊 Poll ended · ${poll.question}`
        : `📊 Poll · ${poll.question}`,
    )
    .setDescription((note ? `*${note}*\n\n` : '') + lines.join('\n\n') + result)
    .addFields(
      { name: 'Status', value: status, inline: true },
      { name: 'Total votes', value: String(total), inline: true },
      { name: 'Channel', value: `<#${poll.channelId}>`, inline: true },
    )
    .setFooter({ text: 'Owner card · edits in place (not a new DM each vote)' })
    .setTimestamp();
}

export async function upsertOwnerPollCard(client, poll, { note = null } = {}) {
  const ids = ownerIds();
  if (!ids.length || !client?.users) return;

  poll.ownerNotify = poll.ownerNotify || {};
  const embed = buildOwnerPollCard(poll, { note });

  for (const ownerId of ids) {
    try {
      const user = await client.users.fetch(ownerId).catch(() => null);
      if (!user) continue;

      const existingId = poll.ownerNotify[ownerId];
      if (existingId) {
        const dm = await user.createDM().catch(() => null);
        const msg = dm
          ? await dm.messages.fetch(existingId).catch(() => null)
          : null;
        if (msg) {
          await msg.edit({ embeds: [embed] }).catch(() => {});
          continue;
        }
        // message deleted in Discord — clear id and resend once
        delete poll.ownerNotify[ownerId];
      }

      const sent = await user.send({ embeds: [embed] }).catch(() => null);
      if (sent) poll.ownerNotify[ownerId] = sent.id;
    } catch (e) {
      logger.debug(`owner poll card ${ownerId}:`, e?.message || e);
    }
  }

  await client.db.set(pollKey(poll.id), poll);
}

/** Public poll embed — bars + live counts + relative end time */
export function buildPollEmbed(poll, { final = false } = {}) {
  const { options, total, winners, max } = getPollStats(poll);
  const showCounts = final || poll.showCounts !== false;

  const lines = options.map((o, i) => {
    const pct = total ? Math.round((o.votes / total) * 100) : 0;
    if (showCounts) {
      const medal =
        final && max > 0 && o.votes === max
          ? o.votes === max && winners.length === 1
            ? '🏆 '
            : '🤝 '
          : `**${i + 1}.** `;
      return `${medal}**${o.label}**\n\`${bar(pct)}\` **${o.votes}** · ${pct}%`;
    }
    return `**${i + 1}.** ${o.label}`;
  });

  let winnerLine = '';
  if (final) {
    if (max === 0) winnerLine = '\n\n**Result:** No votes cast.';
    else if (winners.length === 1)
      winnerLine = `\n\n🏆 **Winner: ${winners[0]}** (${max} vote${max === 1 ? '' : 's'})`;
    else
      winnerLine = `\n\n🤝 **Tie:** ${winners.join(' · ')} (${max} each)`;
  }

  const ends = poll.endsAt
    ? `<t:${Math.floor(poll.endsAt / 1000)}:R> · <t:${Math.floor(poll.endsAt / 1000)}:f>`
    : '—';

  return new EmbedBuilder()
    .setColor(final ? 0x0fdda3 : 0xff4655)
    .setTitle(final ? `Poll closed · ${poll.question}` : `📊 ${poll.question}`)
    .setDescription(lines.join('\n\n') + winnerLine)
    .addFields(
      {
        name: final ? 'Closed' : 'Ends',
        value: final
          ? poll.endedAt
            ? `<t:${Math.floor(poll.endedAt / 1000)}:f>`
            : 'Closed'
          : ends,
        inline: true,
      },
      { name: 'Total votes', value: `**${total}**`, inline: true },
      {
        name: 'Options',
        value: String(options.length),
        inline: true,
      },
    )
    .setFooter({
      text: final
        ? 'Yuri\'s Chamber · poll ended'
        : 'Click a button to vote · you can change your vote',
    })
    .setTimestamp(final ? new Date(poll.endedAt || Date.now()) : new Date());
}

export function buildPollButtons(poll, disabled = false) {
  const rows = [];
  let row = new ActionRowBuilder();
  const { options, total, max } = getPollStats(poll);

  poll.options.forEach((o, i) => {
    if (i > 0 && i % 5 === 0) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    const n = o.votes?.length || 0;
    const label =
      n > 0
        ? `${String(o.label).slice(0, 60)} (${n})`.slice(0, 80)
        : String(o.label).slice(0, 80);

    let style = ButtonStyle.Secondary;
    if (disabled && max > 0 && n === max) style = ButtonStyle.Success;
    else if (!disabled && n > 0) style = ButtonStyle.Primary;

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`poll_vote:${poll.id}:${i}`)
        .setLabel(label)
        .setStyle(style)
        .setDisabled(disabled),
    );
  });
  if (row.components.length) rows.push(row);
  return rows;
}

/** Edit Discord poll message; returns false if message was deleted */
export async function syncPollMessage(client, poll) {
  if (!poll?.channelId || !poll?.messageId) return true;
  try {
    const channel = await client.channels.fetch(poll.channelId).catch(() => null);
    if (!channel?.isTextBased?.()) return false;

    const msg = await channel.messages.fetch(poll.messageId).catch((err) => {
      if (err?.code === 10008 || err?.status === 404) return null; // Unknown Message
      throw err;
    });

    if (!msg) return false;

    await msg
      .edit({
        embeds: [buildPollEmbed(poll, { final: !!poll.ended })],
        components: buildPollButtons(poll, !!poll.ended),
      })
      .catch(() => {});
    return true;
  } catch (e) {
    logger.debug('syncPollMessage:', e?.message || e);
    return true;
  }
}

/**
 * Fully delete a poll: Discord message, owner cards, Firebase keys
 */
export async function deletePoll(client, pollId) {
  const poll = await getPoll(client, pollId);
  if (!poll) {
    await removeActive(client, pollId);
    await removeEnded(client, pollId);
    return { ok: true, missing: true };
  }

  // Delete public message
  if (poll.channelId && poll.messageId) {
    try {
      const channel = await client.channels.fetch(poll.channelId).catch(() => null);
      const msg = channel
        ? await channel.messages.fetch(poll.messageId).catch(() => null)
        : null;
      if (msg) await msg.delete().catch(() => {});
    } catch (_) {}
  }

  // Delete owner DM cards
  if (poll.ownerNotify && client?.users) {
    for (const [ownerId, msgId] of Object.entries(poll.ownerNotify)) {
      try {
        const user = await client.users.fetch(ownerId).catch(() => null);
        if (!user) continue;
        const dm = await user.createDM().catch(() => null);
        const m = dm ? await dm.messages.fetch(msgId).catch(() => null) : null;
        if (m) await m.delete().catch(() => {});
      } catch (_) {}
    }
  }

  await client.db.delete(pollKey(pollId)).catch(() =>
    client.db.set(pollKey(pollId), null),
  );
  await removeActive(client, pollId);
  await removeEnded(client, pollId);

  return { ok: true };
}

/** Remove poll data when Discord message is gone */
export async function purgePollIfMessageMissing(client, poll) {
  if (!poll?.id) return false;
  if (!poll.messageId) return false;

  try {
    const channel = await client.channels.fetch(poll.channelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
      await deletePoll(client, poll.id);
      return true;
    }
    const msg = await channel.messages.fetch(poll.messageId).catch((err) => {
      if (err?.code === 10008) return null;
      return undefined; // network / other — don't purge
    });
    if (msg === null) {
      await deletePoll(client, poll.id);
      return true;
    }
  } catch (_) {}
  return false;
}

export async function endPoll(client, poll) {
  if (!poll || poll.ended) return poll;

  poll.ended = true;
  poll.endedAt = Date.now();
  poll.showCounts = true;
  await client.db.set(pollKey(poll.id), poll);
  await removeActive(client, poll.id);
  await pushEnded(client, poll.id);

  const stillThere = await syncPollMessage(client, poll);
  if (!stillThere) {
    await deletePoll(client, poll.id);
    return null;
  }

  await upsertOwnerPollCard(client, poll, { note: 'Poll closed' }).catch(() => {});
  return poll;
}

export async function checkPolls(client) {
  if (!client?.db) return;
  try {
    const active = (await client.db.get(ACTIVE_KEY, [])) || [];
    const now = Date.now();

    for (const id of [...active]) {
      const poll = await getPoll(client, id);
      if (!poll) {
        await removeActive(client, id);
        continue;
      }
      if (poll.ended) {
        await removeActive(client, id);
        await pushEnded(client, id);
        continue;
      }

      // Discord message deleted → drop from dashboard
      if (await purgePollIfMessageMissing(client, poll)) continue;

      if (poll.endsAt && now >= poll.endsAt) {
        await endPoll(client, poll);
        continue;
      }

      // Refresh embed (time + bars) about every minute via cron
      await syncPollMessage(client, poll);
      await upsertOwnerPollCard(client, poll).catch(() => {});
    }

    // Clean ended list: if message deleted, remove entry
    const ended = (await client.db.get(ENDED_KEY, [])) || [];
    for (const id of [...ended]) {
      const poll = await getPoll(client, id);
      if (!poll) {
        await removeEnded(client, id);
        continue;
      }
      await purgePollIfMessageMissing(client, poll);
    }
  } catch (e) {
    logger.error('checkPolls:', e?.message || e);
  }
}
