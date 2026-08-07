import { SlashCommandBuilder } from 'discord.js';
import {
  getAiConfig,
  generateReply,
  getUserAiHistory,
  saveUserAiHistory,
  clearUserAiHistory,
  saveUserAiPrefs,
  buildSystemInstructions } from '../../services/aiService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const MENTION_RULE =
  '\n\nMENTION RULE: To mention a Discord user you MUST write exactly <@USER_ID> (example: <@885316532673085482>). Never write @Name or bare @numbers without angle brackets.';

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

/** Turn bare @123456... into <@123456...> so Discord can ping */
function normalizeMentions(text) {
  if (!text) return text;
  // already proper <@id>
  // convert @123456789012345678 (17-20 digits) not already inside < >
  return String(text).replace(
    /(^|[^<])@(\d{17,20})\b/g,
    (_, pre, id) => `${pre}<@${id}>`,
  );
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
    const deferOk = await InteractionHelper.safeDefer(interaction, {});
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
        content: 'AI is disabled on this server.' });
    }
    if (!aiReady()) {
      return InteractionHelper.safeEditReply(interaction, {
        content: aiMissingMessage() });
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
      /\b(personal(ize)?|custom(ize)?|be my ai|from now on (you|always))\b/i.test(
        lower,
      )
    ) {
      await saveUserAiPrefs(client, guildId, userId, {
        customStyle: userMessage.slice(0, 800) });
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
      systemInstructions += MENTION_RULE;

      let answer = await generateReply({
        systemInstructions,
        userMessage,
        model: config.model,
        history });

      answer = normalizeMentions(answer);

      const maxLen = config.maxReplyLength || 1800;
      if (answer.length > maxLen) answer = answer.slice(0, maxLen - 3) + '...';
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
        allowedMentions: {
          parse: ['users', 'roles'] } });
    } catch (error) {
      return InteractionHelper.safeEditReply(interaction, {
        content: `AI error: ${error.message}` });
    }
  } };
