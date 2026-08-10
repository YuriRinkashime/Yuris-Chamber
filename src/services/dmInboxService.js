const THREAD_KEY = (userId) => `dm:thread:${userId}`;
const INBOX_KEY = 'dm:inbox';
const AUTO_AI_MS = 5 * 60 * 1000;

const timers = new Map();

export async function getThread(client, userId) {
  return (
    (await client.db.get(THREAD_KEY(userId), null)) || {
      userId: String(userId),
      userTag: null,
      messages: [],
      status: 'open',
      autoAiAt: null,
      ownerNotifyMessageId: null,
      ownerNotifyChannelId: null }
  );
}

export async function saveThread(client, thread) {
  const userId = String(thread.userId);
  await client.db.set(THREAD_KEY(userId), {
    ...thread,
    userId,
    updatedAt: Date.now() });
  const inbox = (await client.db.get(INBOX_KEY, [])) || [];
  const next = [userId, ...inbox.filter((id) => id !== userId)].slice(0, 100);
  await client.db.set(INBOX_KEY, next);
}

export async function listInbox(client) {
  const ids = (await client.db.get(INBOX_KEY, [])) || [];
  const out = [];
  for (const userId of ids.slice(0, 40)) {
    const t = await getThread(client, userId);
    if (t?.messages?.length) out.push(t);
  }
  return out;
}

/** Dashboard delete: clears Mongo thread + owner notify card only. Does NOT wipe user DM history in Discord. */
export async function deleteThread(client, userId) {
  const id = String(userId);
  cancelAutoAi(id);
  const thread = await getThread(client, id);

  // Delete owner notify card in Discord if present
  if (thread?.ownerNotifyMessageId && client?.users) {
    try {
      const owners = String(process.env.OWNER_IDS || process.env.OWNER_ID || '')
        .split(/[,\s]+/)
        .filter(Boolean);
      for (const oid of owners) {
        const user = await client.users.fetch(oid).catch(() => null);
        if (!user) continue;
        const dm = await user.createDM().catch(() => null);
        if (!dm) continue;
        if (thread.ownerNotifyMessageId) {
          const m = await dm.messages.fetch(thread.ownerNotifyMessageId).catch(() => null);
          if (m) await m.delete().catch(() => {});
        }
      }
    } catch (_) {}
  }

  await client.db.delete(THREAD_KEY(id)).catch(() => client.db.set(THREAD_KEY(id), null));
  const inbox = (await client.db.get(INBOX_KEY, [])) || [];
  await client.db.set(
    INBOX_KEY,
    inbox.filter((x) => x !== id),
  );
  return { ok: true };
}

/** Drop inbox entries whose owner-notify message was deleted (optional soft sync) */
export async function syncInboxDeleted(client) {
  if (!client?.db) return;
  const ids = (await client.db.get(INBOX_KEY, [])) || [];
  for (const userId of [...ids]) {
    const t = await getThread(client, userId);
    if (!t?.messages?.length) {
      const inbox = (await client.db.get(INBOX_KEY, [])) || [];
      await client.db.set(
        INBOX_KEY,
        inbox.filter((x) => x !== userId),
      );
    }
  }
}


export async function appendUserDm(client, user, content, attachments = []) {
  const thread = await getThread(client, user.id);
  thread.userTag = user.tag || user.username || thread.userTag;
  thread.userName = user.username || thread.userName || null;
  thread.messages = thread.messages || [];
  const media = (attachments || []).slice(0, 8).map((a) => ({
    url: a.url || a.proxyURL || a,
    name: a.name || 'file',
    contentType: a.contentType || a.content_type || '',
  }));
  thread.messages.push({
    from: 'user',
    content: String(content || '').slice(0, 1800),
    media,
    at: Date.now(),
  });
  thread.status = 'waiting_owner';
  thread.autoAiAt = Date.now() + AUTO_AI_MS;
  thread.messages = thread.messages.slice(-200);
  const PAGE = 8;
  thread.cardPage = Math.max(0, Math.ceil(thread.messages.length / PAGE) - 1);
  await saveThread(client, thread);
  return thread;
}

export async function appendBotDm(client, userId, content, by = 'owner') {
  const thread = await getThread(client, userId);
  thread.messages = thread.messages || [];
  thread.messages.push({
    from: by,
    content: String(content).slice(0, 1800),
    at: Date.now() });
  thread.status = 'open';
  thread.autoAiAt = null;
  thread.messages = thread.messages.slice(-200);
  await saveThread(client, thread);
  return thread;
}

export function cancelAutoAi(userId) {
  const id = String(userId);
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

export function scheduleAutoAi(client, userId) {
  const id = String(userId);
  cancelAutoAi(id);

  const handle = setTimeout(async () => {
    timers.delete(id);
    try {
      const thread = await getThread(client, id);
      if (thread.status !== 'waiting_owner') return;

      const lastUser = [...(thread.messages || [])]
        .reverse()
        .find((m) => m.from === 'user');
      if (!lastUser) return;

      const {
        getAiConfig,
        generateReply,
        buildSystemInstructions } = await import('./aiService.js');

      const guildId = process.env.GUILD_ID;
      const config = await getAiConfig(client, guildId);
      if (!config.enabled) return;

      let answer = await generateReply({
        systemInstructions: await buildSystemInstructions(
          client,
          guildId,
          id,
          (config.systemInstructions || '') +
            '\n\nPrivate DM as Yuri. Owner did not reply in time. Short answer.',
        ),
        userMessage: lastUser.content,
        model: config.model,
        history: [] });
      if (answer.length > 1800) answer = answer.slice(0, 1800) + '...';

      const user = await client.users.fetch(id).catch(() => null);
      if (!user) return;

      answer = String(answer).replace(/<@USER_ID>/gi, `<@${id}>`).replace(/@USER_ID\b/gi, `<@${id}>`).replace(/(^|[^<])@(\d{17,20})\b/g, (_, a, uid) => `${a}<@${uid}>`);
      await user.send({ content: answer, allowedMentions: { users: [...answer.matchAll(/<@!?(\d{17,20})>/g)].map(m => m[1]) } });
      await appendBotDm(client, id, answer, 'ai');
      await updateOwnerNotify(client, id, {
        footer: '🤖 Auto-AI sent',
        lastSent: answer,
        disableButtons: false });
    } catch (e) {
      console.error('Auto AI DM failed:', e?.message || e);
    }
  }, AUTO_AI_MS);

  if (typeof handle.unref === 'function') handle.unref();
  timers.set(id, handle);
}

export function formatThreadPreview(thread, extra = {}) {
  const PAGE = 8;
  const all = thread.messages || [];
  const totalPages = Math.max(1, Math.ceil(all.length / PAGE));
  let page = Number(thread.cardPage ?? totalPages - 1);
  if (!Number.isFinite(page) || page < 0) page = totalPages - 1;
  if (page > totalPages - 1) page = totalPages - 1;
  const slice = all.slice(page * PAGE, page * PAGE + PAGE);

  const lines = slice.map((m) => {
    const who =
      m.from === 'user' ? '👤 User' : m.from === 'ai' ? '🤖 AI' : '✍️ You';
    const text = m.content || (m.media?.length ? '[attachment]' : '');
    return `**${who}:** ${String(text).slice(0, 220)}`;
  });

  let desc = lines.join('\n') || '_No messages_';
  if (totalPages > 1) {
    desc = `_Page ${page + 1}/${totalPages}_\n\n` + desc;
  }

  if (extra.lastSent) {
    desc += `\n\n**📤 Last sent:** ${String(extra.lastSent).slice(0, 400)}`;
  }

  if (thread.status === 'waiting_owner' && thread.autoAiAt) {
    const left = Math.max(0, Math.floor((thread.autoAiAt - Date.now()) / 1000));
    const m = Math.floor(left / 60);
    const s = left % 60;
    desc += `\n\n⏱️ Auto-AI in **${m}m ${s}s** if ignored.`;
  }

  return desc.slice(0, 4000);
}

/** One live card per user in the owner's DM — edits in place when possible */
export async function upsertOwnerNotify(
  client,
  userId,
  { disableButtons = false, lastSent = null, footer = null } = {},
) {
  const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle } = await import('discord.js');

  const thread = await getThread(client, userId);
  const ownerIds = (process.env.OWNER_IDS || process.env.OWNER_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!ownerIds.length) {
    console.warn('upsertOwnerNotify: OWNER_IDS not set');
    return thread;
  }

  const embed = new EmbedBuilder()
    .setColor(disableButtons ? 0x5ddea0 : 0xc4a1ff)
    .setTitle(`DM · ${thread.userTag || userId}`)
    .setDescription(
      `**From:** ${thread.userTag || 'user'} (\`${userId}\`)\n\n` +
        formatThreadPreview(thread, { lastSent }),
    )
    .setFooter({
      text: footer || (disableButtons ? 'Handled' : 'AI reply or your words') })
    .setTimestamp();

  const PAGE = 8;
  const totalPages = Math.max(1, Math.ceil((thread.messages || []).length / PAGE));
  if (thread.cardPage == null) thread.cardPage = totalPages - 1;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dm_page:${userId}:prev`)
      .setLabel('◀ Older')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(totalPages <= 1 || (thread.cardPage || 0) <= 0),
    new ButtonBuilder()
      .setCustomId(`dm_ai:${userId}`)
      .setLabel('AI reply')
      .setEmoji('🤖')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(Boolean(disableButtons)),
    new ButtonBuilder()
      .setCustomId(`dm_human:${userId}`)
      .setLabel('My words')
      .setEmoji('✍️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(Boolean(disableButtons)),
    new ButtonBuilder()
      .setCustomId(`dm_page:${userId}:next`)
      .setLabel('Newer ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(totalPages <= 1 || (thread.cardPage || 0) >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`dm_page:${userId}:latest`)
      .setLabel('Jump to latest')
      .setStyle(ButtonStyle.Success)
      .setDisabled(totalPages <= 1 || (thread.cardPage || 0) >= totalPages - 1),
  );

  for (const oid of ownerIds) {
    try {
      const owner = await client.users.fetch(oid).catch(() => null);
      if (!owner) continue;

      const dm = await owner.createDM().catch(() => null);
      if (!dm) continue;

      let edited = false;

      if (thread.ownerNotifyMessageId) {
        try {
          const msg = await dm.messages.fetch(thread.ownerNotifyMessageId);
          if (msg) {
            await msg.edit({ embeds: [embed], components: [row] });
            edited = true;
            thread.ownerNotifyChannelId = dm.id;
          }
        } catch (_) {
          // deleted / missing — send a new card
        }
      }

      if (!edited) {
        const sent = await dm.send({ embeds: [embed], components: [row] });
        thread.ownerNotifyMessageId = sent.id;
        thread.ownerNotifyChannelId = dm.id;
      }

      await saveThread(client, thread);
    } catch (e) {
      console.error('upsertOwnerNotify failed:', e?.message || e);
    }
  }

  return thread;
}

export async function updateOwnerNotify(client, userId, opts = {}) {
  return upsertOwnerNotify(client, userId, opts);
}
