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

export async function listActivePolls(client, { verifyDiscord = true } = {}) {
  const ids = (await client.db.get(ACTIVE_KEY, [])) || [];
  const out = [];
  for (const id of ids) {
    let p = await getPoll(client, id);
    if (!p || p.ended) continue;
    if (verifyDiscord && client.channels) {
      const gone = await purgePollIfMessageMissing(client, p);
      if (gone) continue;
      p = await getPoll(client, id);
      if (!p || p.ended) continue;
    }
    out.push(p);
  }
  return out.sort((a, b) => (a.endsAt || 0) - (b.endsAt || 0));
}

export async function listEndedPolls(client, { verifyDiscord = true } = {}) {
  const ids = (await client.db.get(ENDED_KEY, [])) || [];
  const out = [];
  for (const id of ids) {
    let p = await getPoll(client, id);
    if (!p) {
      await removeEnded(client, id);
      continue;
    }
    if (verifyDiscord && client.channels) {
      const gone = await purgePollIfMessageMissing(client, p);
      if (gone) continue;
      p = await getPoll(client, id);
      if (!p) continue;
    }
    out.push(p);
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

/** Public poll embed — hide live counts until closed */
export function buildPollEmbed(poll, { final = false } = {}) {
  const { options, total, winners, max } = getPollStats(poll);
  const reveal = final || poll.ended === true;

  let lines;
  if (reveal) {
    lines = options.map((o, i) => {
      const pct = total ? Math.round((o.votes / total) * 100) : 0;
      const medal =
        max > 0 && o.votes === max
          ? winners.length === 1
            ? '🏆 '
            : '🤝 '
          : `**${i + 1}.** `;
      return `${medal}**${o.label}**\n\`${bar(pct)}\` **${o.votes}** · ${pct}%`;
    });
  } else {
    lines = options.map((o, i) => `**${i + 1}.** ${o.label}`);
  }

  let winnerLine = '';
  if (reveal) {
    if (max === 0) winnerLine = '\n\n**Result:** No votes cast.';
    else if (winners.length === 1)
      winnerLine = `\n\n🏆 **Winner: ${winners[0]}** (${max} vote${max === 1 ? '' : 's'})`;
    else
      winnerLine = `\n\n🤝 **Tie:** ${winners.join(' · ')} (${max} each)`;
  }

  const ends = poll.endsAt
    ? `<t:${Math.floor(poll.endsAt / 1000)}:R>\n<t:${Math.floor(poll.endsAt / 1000)}:f>`
    : '—';

  const embed = new EmbedBuilder()
    .setColor(reveal ? 0x0fdda3 : 0xff4655)
    .setTitle(reveal ? `Poll closed · ${poll.question}` : `📊 ${poll.question}`)
    .setDescription(lines.join('\n\n') + winnerLine)
    .addFields(
      {
        name: reveal ? 'Closed' : '⏱ Ends',
        value: reveal
          ? poll.endedAt
            ? `<t:${Math.floor(poll.endedAt / 1000)}:f>`
            : 'Closed'
          : ends,
        inline: true,
      },
      {
        name: reveal ? 'Total votes' : 'Options',
        value: reveal ? `**${total}**` : `**${options.length}** choices`,
        inline: true,
      },
      {
        name: 'Status',
        value: reveal ? '🔒 Results in' : '🗳️ Voting open',
        inline: true,
      },
    )
    .setFooter({
      text: reveal
        ? "Yuri's Chamber · results"
        : "Yuri's Chamber · votes are hidden until the poll ends · change vote anytime",
    })
    .setTimestamp(reveal ? new Date(poll.endedAt || Date.now()) : new Date());

  return embed;
}

export function buildPollButtons(poll, disabled = false) {
  const rows = [];
  let row = new ActionRowBuilder();
  const { max } = getPollStats(poll);
  const reveal = disabled || poll.ended === true;

  poll.options.forEach((o, i) => {
    if (i > 0 && i % 5 === 0) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    const n = o.votes?.length || 0;
    const label = reveal
      ? `${String(o.label).slice(0, 55)} (${n})`.slice(0, 80)
      : String(o.label).slice(0, 80);

    let style = ButtonStyle.Secondary;
    if (reveal && max > 0 && n === max) style = ButtonStyle.Success;
    else if (!reveal) style = ButtonStyle.Primary;

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`poll_vote:${poll.id}:${i}`)
        .setLabel(label || `Option ${i + 1}`)
        .setStyle(style)
        .setDisabled(disabled),
    );
  });
  if (row.components.length) rows.push(row);

  // Staff controls (always shown while open; disabled when ended)
  if (!disabled && !poll.ended) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`poll_edit:${poll.id}`)
          .setLabel('Edit poll')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('✏️'),
        new ButtonBuilder()
          .setCustomId(`poll_end:${poll.id}`)
          .setLabel('End poll')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('⏹️'),
      ),
    );
  }

  return rows;
}

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
  if (!poll.messageId || !poll.channelId) return false;

  try {
    const channel = await client.channels.fetch(poll.channelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
      await deletePoll(client, poll.id);
      return true;
    }
    try {
      await channel.messages.fetch(poll.messageId);
      return false; // still exists
    } catch (err) {
      const code = err?.code || err?.rawError?.code;
      // 10008 Unknown Message, 50001 Missing Access, 50013 Missing Permissions
      if (code === 10008 || code === 1025 || String(err?.message || '').includes('Unknown Message')) {
        await deletePoll(client, poll.id);
        return true;
      }
      // Other errors: don't purge
      return false;
    }
  } catch (_) {
    return false;
  }
}


/** Check if member can manage this poll */
export function canManagePoll(interaction, poll) {
  if (!interaction.memberPermissions) {
    // DM / missing — allow bot owner via env
    const owners = String(process.env.OWNER_IDS || process.env.OWNER_ID || '')
      .split(/[,\s]+/)
      .filter(Boolean);
    return owners.includes(interaction.user.id);
  }
  if (interaction.memberPermissions.has('ManageMessages')) return true;
  if (poll?.createdBy && poll.createdBy === interaction.user.id) return true;
  const owners = String(process.env.OWNER_IDS || process.env.OWNER_ID || '')
    .split(/[,\s]+/)
    .filter(Boolean);
  return owners.includes(interaction.user.id);
}

/** Apply edits from dashboard or Discord modal */
export async function applyPollEdit(client, poll, {
  question,
  optionsText,
  minutes,
} = {}) {
  if (!poll || poll.ended) return { ok: false, error: 'Poll already ended' };

  if (question && String(question).trim()) {
    poll.question = String(question).trim().slice(0, 200);
  }

  if (optionsText != null && String(optionsText).trim()) {
    const labels = String(optionsText)
      .split(/\r?\n|\|/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (labels.length < 2) {
      return { ok: false, error: 'Need at least 2 options' };
    }
    // Keep votes for matching labels; drop votes for removed labels
    const oldByLabel = Object.fromEntries(
      (poll.options || []).map((o) => [o.label, o.votes || []]),
    );
    poll.options = labels.map((label, i) => ({
      id: i,
      label: label.slice(0, 80),
      votes: oldByLabel[label] ? [...oldByLabel[label]] : [],
    }));
  }

  if (minutes != null && String(minutes).trim() !== '') {
    const m = parseInt(minutes, 10);
    if (!Number.isFinite(m) || m < 1 || m > 10080) {
      return { ok: false, error: 'Minutes must be 1–10080' };
    }
    poll.endsAt = Date.now() + m * 60 * 1000;
  }

  await savePoll(client, poll);
  await syncPollMessage(client, poll);
  await upsertOwnerPollCard(client, poll, { note: 'Poll edited' }).catch(() => {});
  return { ok: true, poll };
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
