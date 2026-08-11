import {
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';
import {
  listAiModels,
  findAiModel,
  getUserAiPrefs,
  saveUserAiPrefs,
  resolveUserModel,
  getAiConfig,
} from '../../services/aiService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('aimodel')
    .setDescription('View or set YOUR AI model (keeps the same chat history)')
    .addStringOption((o) =>
      o
        .setName('model')
        .setDescription('Model to use (leave empty to see current + list)')
        .setRequired(false)
        .addChoices(
          { name: 'CosmosRP V2.1 (Vision · RP)', value: 'cosmosrp-2.1' },
          { name: 'Gemma 4 26B Free (OpenRouter)', value: 'gemma-4-26b-free' },
          { name: 'Server default (reset)', value: 'default' },
        ),
    ),

  category: 'utility',

  async execute(interaction) {
    const client = interaction.client;
    const guildId = interaction.guildId || process.env.GUILD_ID;
    const userId = interaction.user.id;
    const pick = interaction.options.getString('model');

    if (pick) {
      if (pick === 'default') {
        await saveUserAiPrefs(client, guildId, userId, { modelId: null });
        const server = await getAiConfig(client, guildId);
        return interaction.reply({
          content:
            `✅ Your AI model is now the **server default**: \`${server.modelId}\` (${server.model}).\n` +
            `_Chat history is shared — only the model changes._`,
          flags: MessageFlags.Ephemeral,
        });
      }
      const m = findAiModel(pick);
      if (!m) {
        return interaction.reply({
          content: 'Unknown model.',
          flags: MessageFlags.Ephemeral,
        });
      }
      await saveUserAiPrefs(client, guildId, userId, { modelId: m.id });
      return interaction.reply({
        content:
          `✅ Your AI model is now **${m.label}** (\`${m.id}\`).\n` +
          `${m.vision ? '👁 Vision: yes' : '📝 Text only'} · ${m.free ? 'Free' : 'Key required'}\n` +
          `_Same conversation history — only the engine changes._`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const current = await resolveUserModel(client, guildId, userId);
    const prefs = await getUserAiPrefs(client, guildId, userId);
    const server = await getAiConfig(client, guildId);
    const lines = listAiModels()
      .map(
        (m) =>
          `• **${m.label}** — \`${m.id}\`${m.id === current.id ? ' ← **you**' : ''}${
            m.id === server.modelId ? ' _(server default)_' : ''
          }`,
      )
      .join('\n');

    return interaction.reply({
      content:
        `**Your AI model:** ${current.label} (\`${current.id}\`)\n` +
        `Source: ${prefs.modelId ? 'your override' : 'server default'}\n\n` +
        `**Available models**\n${lines}\n\n` +
        `Switch with \`/aimodel model:\` — history stays the same.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
