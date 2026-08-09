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

export async function listActivePolls(client, { verifyDiscord = false } = {}) {
  if (!client?.db) return [];
  const ids = (await client.db.get(ACTIVE_KEY, [])) || [];
  const out = [];
  // Parallel verify (fast) when requested
  const loaded = [];
  for (const id of ids) {
    const p = await getPoll(client, id);
    if (!p) {
      await removeActive(client, id);
      continue;
    }
    if (p.ended) {
      await removeActive(client, id);
      await pushEnded(client, id);
      continue;
    }
    loaded.push(p);
  }
  if (verifyDiscord && client.channels && loaded.length) {
    const checks = await Promise.all(
      loaded.map(async (p) => {
        const exists = await discordPollMessageExists(client, p);
        if (!exists) {
          await deletePoll(client, p.id);
          return null;
        }
        return p;
      }),
    );
    for (const p of checks) if (p) out.push(p);
  } else {
    out.push(...loaded);
  }
  return out.sort((a, b) => (a.endsAt || 0) - (b.endsAt || 0));
}

export async function listEndedPolls(client, { verifyDiscord = false } = {}) {
  if (!client?.db) return [];
  const ids = (await client.db.get(ENDED_KEY, [])) || [];
  const loaded = [];
  for (const id of ids) {
    const p = await getPoll(client, id);
    if (!p) {
      await removeEnded(client, id);
      continue;
    }
    loaded.push(p);
  }
  const out = [];
  if (verifyDiscord && client.channels && loaded.length) {
    const checks = await Promise.all(
      loaded.map(async (p) => {
        const exists = await discordPollMessageExists(client, p);
        if (!exists) {
          await deletePoll(client, p.id);
          return null;
        }
        return p;
      }),
    );
    for (const p of checks) if (p) out.push(p);
  } else {
    out.push(...loaded);
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

export function buildOwnerControlButtons(poll) {
  if (poll.ended) return [];
  return [
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
  ];
}

export async function upsertOwnerPollCard(client, poll, { note = null } = {}) {
  const ids = ownerIds();
  if (!ids.length || !client?.users) return;

  poll.ownerNotify = poll.ownerNotify || {};
  const embed = buildOwnerPollCard(poll, { note });
  const components = buildOwnerControlButtons(poll);

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
          await msg.edit({ embeds: [embed], components }).catch(() => {});
          continue;
        }
        delete poll.ownerNotify[ownerId];
      }

      const sent = await user
        .send({ embeds: [embed], components })
        .catch(() => null);
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
  // Edit / End only on dashboard + owner DM — not on public poll message
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

async function withTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** true = message still exists, false = deleted / missing channel */
export async function discordPollMessageExists(client, poll) {
  if (!poll?.messageId || !poll?.channelId || !client?.channels) return true;
  try {
    const channel = await withTimeout(
      client.channels.fetch(poll.channelId).catch((e) => {
        if (e?.code === 10003) return null; // unknown channel
        throw e;
      }),
      2000,
      'timeout',
    );
    if (channel === 'timeout') return true; // don't purge on lag
    if (!channel?.isTextBased?.()) return false;

    const msg = await withTimeout(
      channel.messages.fetch(poll.messageId).then(
        (m) => m,
        (e) => {
          if (e?.code === 10008) return null;
          throw e;
        },
      ),
      2000,
      'timeout',
    );
    if (msg === 'timeout') return true;
    return !!msg;
  } catch (e) {
    if (e?.code === 10008 || e?.code === 10003) return false;
    return true;
  }
}

/** Remove poll data when Discord message is gone */
export async function purgePollIfMessageMissing(client, poll) {
  if (!poll?.id) return false;
  if (!poll.messageId || !poll.channelId) return false;
  const exists = await discordPollMessageExists(client, poll);
  if (exists) return false;
  await deletePoll(client, poll.id);
  return true;
}


/** Check if member can manage this poll */
export function canManagePoll(interaction, poll) {
  if (!interaction?.user?.id) return false;
  const owners = String(process.env.OWNER_IDS || process.env.OWNER_ID || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (owners.includes(interaction.user.id)) return true;
  if (poll?.createdBy && poll.createdBy === interaction.user.id) return true;
  try {
    if (interaction.memberPermissions?.has?.('ManageMessages')) return true;
  } catch (_) {}
  return false;
}

/** Apply edits from dashboard or Discord modal */
export async function applyPollEdit(client, poll, {
  question,
  optionsText,
  minutes,
  seconds,
  totalSeconds,
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
    const oldByLabel = Object.fromEntries(
      (poll.options || []).map((o) => [o.label, o.votes || []]),
    );
    poll.options = labels.map((label, i) => ({
      id: i,
      label: label.slice(0, 80),
      votes: oldByLabel[label] ? [...oldByLabel[label]] : [],
    }));
  }

  let addMs = null;
  if (totalSeconds != null && String(totalSeconds).trim() !== '') {
    const sec = parseInt(totalSeconds, 10);
    if (!Number.isFinite(sec) || sec < 10 || sec > 10080 * 60) {
      return { ok: false, error: 'Duration must be 10 seconds – 7 days' };
    }
    addMs = sec * 1000;
  } else {
    const m =
      minutes != null && String(minutes).trim() !== ''
        ? parseInt(minutes, 10)
        : 0;
    const s =
      seconds != null && String(seconds).trim() !== ''
        ? parseInt(seconds, 10)
        : 0;
    if (m || s) {
      if (!Number.isFinite(m) || m < 0 || m > 10080) {
        return { ok: false, error: 'Minutes must be 0–10080' };
      }
      if (!Number.isFinite(s) || s < 0 || s > 59) {
        return { ok: false, error: 'Seconds must be 0–59' };
      }
      const total = m * 60 + s;
      if (total < 10) {
        return { ok: false, error: 'Minimum duration is 10 seconds' };
      }
      addMs = total * 1000;
    }
  }
  if (addMs != null) {
    poll.endsAt = Date.now() + addMs;
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
    // Skip Discord verify on cron — only end expired polls (cheap)
    const active = (await client.db.get(ACTIVE_KEY, [])) || [];
    if (!active.length) return;
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
      if (poll.endsAt && now >= poll.endsAt) {
        await endPoll(client, poll);
        continue;
      }
      // Refresh embed at most when within last 2 min of ending (saves Discord + DB)
      if (poll.endsAt && poll.endsAt - now < 120_000) {
        await syncPollMessage(client, poll).catch(() => {});
      }
    }
  } catch (e) {
    logger.error('checkPolls:', e?.message || e);
  }
}
