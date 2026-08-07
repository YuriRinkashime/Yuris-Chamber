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

export async function appendUserDm(client, user, content) {
  const thread = await getThread(client, user.id);
  thread.userTag = user.tag;
  thread.messages = thread.messages || [];
  thread.messages.push({
    from: 'user',
    content: String(content).slice(0, 1800),
    at: Date.now() });
  thread.status = 'waiting_owner';
  thread.autoAiAt = Date.now() + AUTO_AI_MS;
  thread.messages = thread.messages.slice(-30);
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
  thread.messages = thread.messages.slice(-30);
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

      await user.send({ content: answer.replace(/(^|[^<])@(\d{17,20})\b/g, (_, a, id) => `${a}<@${id}>`), allowedMentions: { parse: ['users'] } });
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
  const lines = (thread.messages || []).slice(-8).map((m) => {
    const who =
      m.from === 'user' ? '👤 User' : m.from === 'ai' ? '🤖 AI' : '✍️ You';
    return `**${who}:** ${String(m.content).slice(0, 220)}`;
  });

  let desc = lines.join('\n') || '_No messages_';

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

  const row = new ActionRowBuilder().addComponents(
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
