import { SlashCommandBuilder } from 'discord.js';
import {
  getAiConfig,
  generateReply,
  getUserAiHistory,
  saveUserAiHistory,
  clearUserAiHistory,
  getUserAiPrefs,
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
    ),

  category: 'utility',

  async execute(interaction) {
    // PUBLIC — whole channel can see
    const deferOk = await InteractionHelper.safeDefer(interaction, {
      ephemeral: false,
    });
    if (!deferOk) return;

    const client = interaction.client;
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const reset = interaction.options.getBoolean('reset') || false;
    const userMessage = interaction.options.getString('message', true);

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

    // Language prefs
    if (/\b(bisaya|cebuano)\b/i.test(userMessage) && /\b(yes|oo|sige|please|from now|bet|go)\b/i.test(lower)) {
      await saveUserAiPrefs(client, guildId, userId, { language: 'ceb' });
    }
    if (/\b(tagalog|filipino)\b/i.test(userMessage) && /\b(yes|oo|sige|please|from now|bet|go)\b/i.test(lower)) {
      await saveUserAiPrefs(client, guildId, userId, { language: 'tl' });
    }
    if (/\b(english)\b/i.test(userMessage) && /\b(yes|please|from now|bet|go)\b/i.test(lower)) {
      await saveUserAiPrefs(client, guildId, userId, { language: 'en' });
    }

    // Personal customization
    if (/\b(personal(ize)?|custom(ize)?|be my ai|from now on (you|always))\b/i.test(lower)) {
      await saveUserAiPrefs(client, guildId, userId, {
        customStyle: userMessage.slice(0, 800),
      });
    }
    if (/\b(reset (style|personality|ai)|default yuri|normal mode)\b/i.test(lower)) {
      await saveUserAiPrefs(client, guildId, userId, { customStyle: null });
    }

    try {
      const history = await getUserAiHistory(client, guildId, userId);
      const systemInstructions = await buildSystemInstructions(
        client,
        guildId,
        userId,
        config.systemInstructions,
      );

      let answer = await generateReply({
        systemInstructions,
        userMessage,
        model: config.model,
        history,
      });

      if (answer.length > config.maxReplyLength) {
        answer = answer.slice(0, config.maxReplyLength - 3) + '...';
      }
      if (answer.length > 1800) answer = answer.slice(0, 1800) + '...';

      await saveUserAiHistory(client, guildId, userId, [
        ...history,
        { role: 'user', parts: [{ text: userMessage }] },
        { role: 'model', parts: [{ text: answer }] },
      ]);

      return InteractionHelper.safeEditReply(interaction, {
        content:
          `**${interaction.user}** asked:\n> ${userMessage.slice(0, 300)}${
            userMessage.length > 300 ? '…' : ''
          }\n\n${answer}`,
      });
    } catch (error) {
      return InteractionHelper.safeEditReply(interaction, {
        content: `AI error: ${error.message}`,
      });
    }
  },
};
