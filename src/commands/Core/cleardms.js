import { SlashCommandBuilder, MessageFlags, ChannelType } from 'discord.js';
import { isBotOwner } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';

async function deleteBotMessagesInDm(client, userId, limit = 50) {
  let deleted = 0;
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return 0;

    const dm = await user.createDM().catch(() => null);
    if (!dm) return 0;

    // Delete bot notify card if we stored it
    try {
      const thread = (await client.db.get(`dm:thread:${userId}`, null)) || {};
      if (thread.ownerNotifyMessageId) {
        const msg = await dm.messages
          .fetch(thread.ownerNotifyMessageId)
          .catch(() => null);
        if (msg?.deletable) {
          await msg.delete().catch(() => {});
          deleted += 1;
        }
      }
    } catch (_) {}

    // Walk recent messages and delete ones from the bot
    let lastId = undefined;
    let scanned = 0;
    while (scanned < limit) {
      const batch = await dm.messages
        .fetch({ limit: 50, ...(lastId ? { before: lastId } : {}) })
        .catch(() => null);
      if (!batch || batch.size === 0) break;

      const list = [...batch.values()];
      for (const msg of list) {
        scanned += 1;
        lastId = msg.id;
        if (msg.author?.id !== client.user.id) continue;
        if (!msg.deletable) continue;
        await msg.delete().catch(() => {});
        deleted += 1;
        // small delay to avoid rate limits
        await new Promise((r) => setTimeout(r, 350));
        if (deleted >= limit) break;
      }
      if (list.length < 50 || deleted >= limit) break;
    }
  } catch (e) {
    logger.warn(`cleardms delete for ${userId}:`, e?.message);
  }
  return deleted;
}

async function clearThreadData(db, userId) {
  const key = `dm:thread:${userId}`;
  if (typeof db.delete === 'function') {
    await db.delete(key);
  } else {
    await db.set(key, {
      userId: String(userId),
      messages: [],
      status: 'open',
      autoAiAt: null,
      ownerNotifyMessageId: null,
      ownerNotifyChannelId: null,
    });
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('cleardms')
    .setDescription('Clear bot DM inbox + delete bot messages in those DMs (owner)')
    .addStringOption((o) =>
      o
        .setName('user_id')
        .setDescription('Only clear this user (optional)')
        .setRequired(false),
    )
    .addBooleanOption((o) =>
      o
        .setName('discord')
        .setDescription('Also delete bot messages in Discord DMs (default: true)')
        .setRequired(false),
    ),

  category: 'core',

  async execute(interaction) {
    if (!isBotOwner(interaction.user.id)) {
      return interaction.reply({
        content: 'Owner only.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const db = interaction.client.db;
    const one = interaction.options.getString('user_id');
    const doDiscord = interaction.options.getBoolean('discord');
    const wipeDiscord = doDiscord !== false; // default true

    let ids = [];
    if (one) {
      ids = [one.trim()];
    } else {
      ids = (await db.get('dm:inbox', [])) || [];
    }

    let removedThreads = 0;
    let deletedMsgs = 0;

    for (const id of ids) {
      if (wipeDiscord) {
        deletedMsgs += await deleteBotMessagesInDm(interaction.client, id, 40);
      }
      await clearThreadData(db, id);
      removedThreads += 1;
    }

    if (one) {
      const inbox = (await db.get('dm:inbox', [])) || [];
      await db.set(
        'dm:inbox',
        inbox.filter((id) => id !== one.trim()),
      );
    } else {
      await db.set('dm:inbox', []);
    }

    return interaction.editReply({
      content:
        `Cleared **${removedThreads}** thread(s) from the inbox` +
        (wipeDiscord
          ? ` · deleted **${deletedMsgs}** bot message(s) in Discord DMs`
          : '') +
        `.\n\n_Note: Discord only allows deleting **the bot’s** messages, not the other user’s._`,
    });
  },
};
