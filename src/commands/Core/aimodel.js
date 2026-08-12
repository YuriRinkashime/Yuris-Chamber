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
    .setDescription('Set YOUR personal AI model only (does not change server default)')
    .addStringOption((o) =>
      o
        .setName('model')
        .setDescription('Your model (leave empty to see current)')
        .setRequired(false)
        .addChoices(
          { name: 'CosmosRP V2.1 (Vision · RP)', value: 'cosmosrp-2.1' },
          { name: 'Gemma 4 26B Free (OpenRouter)', value: 'gemma-4-26b-free' },
          { name: 'Llama 3.3 70B (Naga free)', value: 'naga-llama-free' },
          { name: 'Use server default', value: 'default' },
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
            `✅ **Only you** now use the server default: **${server.modelId}**.\n` +
            `_This does **not** change the server setting for others._\n` +
            `_Chat history is unchanged._`,
          flags: MessageFlags.Ephemeral,
        });
      }
      const m = findAiModel(pick);
      if (!m) {
        return interaction.reply({ content: 'Unknown model.', flags: MessageFlags.Ephemeral });
      }
      await saveUserAiPrefs(client, guildId, userId, { modelId: m.id });
      return interaction.reply({
        content:
          `✅ **Your personal model** is now **${m.label}**.\n` +
          `${m.vision ? '👁 Vision' : '📝 Text'} · ${m.free ? 'Free' : 'Key required'}\n` +
          `_Only affects **you** — server default is unchanged._\n` +
          `_Same conversation history._`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const current = await resolveUserModel(client, guildId, userId);
    const prefs = await getUserAiPrefs(client, guildId, userId);
    const server = await getAiConfig(client, guildId);
    const lines = listAiModels()
      .map(
        (m) =>
          `• **${m.label}** (\`${m.id}\`)` +
          (m.id === current.id ? ' ← **you**' : '') +
          (m.id === server.modelId ? ' · server default' : ''),
      )
      .join('\n');

    return interaction.reply({
      content:
        `**Your model:** ${current.label}\n` +
        `**Scope:** ${prefs.modelId ? 'personal override' : 'following server default'}\n` +
        `**Server default:** ${server.modelId}\n\n` +
        `${lines}\n\n` +
        `\`/aimodel model:\` changes **only your** model.\n` +
        `Server default is set in the **dashboard → AI**.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
