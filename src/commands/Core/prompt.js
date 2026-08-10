import { SlashCommandBuilder } from 'discord.js';
import {
  getAiConfig,
  generateReply,
  getUserAiHistory,
  saveUserAiHistory,
  clearUserAiHistory,
  saveUserAiPrefs,
  buildSystemInstructions,
} from '../../services/aiService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

function provider() {
  return (process.env.AI_PROVIDER || 'naga').toLowerCase();
}

function aiReady() {
  const p = provider();
  if (p === 'gemini') return Boolean(process.env.GEMINI_API_KEY);
  if (p === 'openai') return Boolean(process.env.OPENAI_API_KEY);
  return Boolean(process.env.NAGA_API_KEY || process.env.OPENAI_API_KEY);
}

function aiMissingMessage() {
  const p = provider();
  if (p === 'naga') return 'AI is not configured (missing NAGA_API_KEY).';
  if (p === 'openai') return 'AI is not configured (missing OPENAI_API_KEY).';
  return 'AI is not configured (missing GEMINI_API_KEY).';
}

/**
 * Fix AI mention mistakes:
 * - literal <@USER_ID> / @USER_ID placeholders → real speaker id
 * - bare @123456789012345678 → <@123...>
 */
function fixMentions(text, currentUserId) {
  if (!text) return text;
  let out = String(text);

  // Placeholder tokens the model copies from instructions
  out = out.replace(/<@USER_ID>/gi, `<@${currentUserId}>`);
  out = out.replace(/@USER_ID\b/gi, `<@${currentUserId}>`);
  out = out.replace(/\{USER_ID\}/gi, currentUserId);

  // Bare @snowflake not already wrapped
  out = out.replace(/(^|[^<])@(\d{17,20})\b/g, (_, pre, id) => `${pre}<@${id}>`);

  return out;
}

export default {
  data: new SlashCommandBuilder()
    .setName('prompt')
    .setDescription('Ask Yuri (public answer · your own memory)')
    .addStringOption((o) =>
      o
        .setName('message')
        .setDescription('Your message')
        .setRequired(true)
        .setMaxLength(1500),
    )
    .addBooleanOption((o) =>
      o
        .setName('reset')
        .setDescription('Clear YOUR chat history')
        .setRequired(false),
    )
    .addAttachmentOption((o) =>
      o
        .setName('image')
        .setDescription('Photo or GIF for the AI to look at')
        .setRequired(false),
    ),

  category: 'utility',

  async execute(interaction) {
    const deferOk = await InteractionHelper.safeDefer(interaction, {});
    if (!deferOk) return;

    const client = interaction.client;
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const reset = interaction.options.getBoolean('reset') || false;
    const userMessage = interaction.options.getString('message', true);
    const attachment = interaction.options.getAttachment('image');
    let imageUrls = [];
    let mediaNote = '';
    if (attachment?.url) {
      imageUrls = [attachment.url];
      const name = (attachment.name || '').toLowerCase();
      const ct = (attachment.contentType || '').toLowerCase();
      if (ct.includes('gif') || name.endsWith('.gif')) mediaNote = `[User sent a GIF: ${attachment.url}]`;
      else mediaNote = `[User sent a photo/image: ${attachment.url}]`;
    }

    if (reset) {
      await clearUserAiHistory(client, guildId, userId);
    }

    const config = await getAiConfig(client, guildId);
    if (!config.enabled) {
      return InteractionHelper.safeEditReply(interaction, {
        content: 'AI is disabled on this server.',
      });
    }
    if (!aiReady()) {
      return InteractionHelper.safeEditReply(interaction, {
        content: aiMissingMessage(),
      });
    }

    const lower = userMessage.toLowerCase().trim();

    if (
      /\b(bisaya|cebuano)\b/i.test(userMessage) &&
      /\b(yes|oo|sige|please|from now|bet|go)\b/i.test(lower)
    ) {
      await saveUserAiPrefs(client, guildId, userId, { language: 'ceb' });
    }
    if (
      /\b(tagalog|filipino)\b/i.test(userMessage) &&
      /\b(yes|oo|sige|please|from now|bet|go)\b/i.test(lower)
    ) {
      await saveUserAiPrefs(client, guildId, userId, { language: 'tl' });
    }
    if (
      /\b(english)\b/i.test(userMessage) &&
      /\b(yes|please|from now|bet|go)\b/i.test(lower)
    ) {
      await saveUserAiPrefs(client, guildId, userId, { language: 'en' });
    }

    if (
      /\b(personal(ize)?|custom(ize)?|be my ai|from now on (you|always))\b/i.test(lower)
    ) {
      await saveUserAiPrefs(client, guildId, userId, {
        customStyle: userMessage.slice(0, 800),
      });
    }
    if (/\b(reset (style|personality|ai)|default yuri|normal mode)\b/i.test(lower)) {
      await saveUserAiPrefs(client, guildId, userId, { customStyle: null });
    }

    try {
      const history = await getUserAiHistory(client, guildId, userId);
      let systemInstructions = await buildSystemInstructions(
        client,
        guildId,
        userId,
        config.systemInstructions,
      );

      // Real IDs — never tell the model to type the words USER_ID
      systemInstructions +=
        `\n\nCurrent speaker: ${interaction.user.username} (Discord ID ${userId}).` +
        `\nTo mention THIS speaker write exactly: <@${userId}>` +
        `\nTo mention someone else, only use a real numeric Discord ID inside <@...>.` +
        `\nNever write the text USER_ID, <@USER_ID>, or @USER_ID as a placeholder.`;

      let finalMsg = userMessage;
      if (mediaNote) {
        finalMsg = userMessage + '\n\n' + mediaNote + '\n(React to the photo/GIF — describe what you see when relevant.)';
      }
      let answer = await generateReply({
        systemInstructions,
        userMessage: finalMsg,
        model: config.model,
        history,
        imageUrls,
      });

      answer = fixMentions(answer, userId);

      const maxLen = config.maxReplyLength || 1800;
      if (answer.length > maxLen) answer = answer.slice(0, maxLen - 3) + '...';
      if (answer.length > 1800) answer = answer.slice(0, 1800) + '...';

      await saveUserAiHistory(client, guildId, userId, [
        ...history,
        { role: 'user', parts: [{ text: userMessage }] },
        { role: 'model', parts: [{ text: answer }] },
      ]);

      // Extract user ids to allow-mention explicitly (more reliable than parse)
      const mentionIds = [...answer.matchAll(/<@!?(\d{17,20})>/g)].map((m) => m[1]);

      return InteractionHelper.safeEditReply(interaction, {
        content:
          `**${interaction.user}** asked:\n> ${userMessage.slice(0, 300)}${
            userMessage.length > 300 ? '…' : ''
          }\n\n${answer}`,
        allowedMentions: {
          users: mentionIds.length ? mentionIds : [userId],
        },
      });
    } catch (error) {
      return InteractionHelper.safeEditReply(interaction, {
        content: `AI error: ${error.message}`,
      });
    }
  },
};
