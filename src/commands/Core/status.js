import {
  SlashCommandBuilder,
  ActivityType,
  MessageFlags,
} from 'discord.js';

const OWNER_ID = '885316532673085482';

const TYPE_MAP = {
  Playing: ActivityType.Playing,
  Watching: ActivityType.Watching,
  Listening: ActivityType.Listening,
  Competing: ActivityType.Competing,
  Custom: ActivityType.Custom,
};

function buildPresence(text, typeName) {
  const type = TYPE_MAP[typeName] ?? ActivityType.Custom;
  if (type === ActivityType.Custom) {
    return {
      activities: [{ name: 'Custom Status', type: ActivityType.Custom, state: text }],
      status: 'online',
    };
  }
  return {
    activities: [{ name: text, type }],
    status: 'online',
  };
}

export default {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Change bot status (owner · saved)')
    .addStringOption((o) =>
      o.setName('text').setDescription('Status text').setRequired(true).setMaxLength(128),
    )
    .addStringOption((o) =>
      o
        .setName('type')
        .setDescription('Type')
        .addChoices(
          { name: 'Playing', value: 'Playing' },
          { name: 'Watching', value: 'Watching' },
          { name: 'Listening', value: 'Listening' },
          { name: 'Competing', value: 'Competing' },
          { name: 'Custom', value: 'Custom' },
        ),
    ),

  category: 'core',

  async execute(interaction) {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({
        content: 'Only the bot owner can use this.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const text = interaction.options.getString('text', true);
    const typeName = interaction.options.getString('type') || 'Custom';
    const presence = buildPresence(text, typeName);

    await interaction.client.user.setPresence(presence);

    await interaction.client.db.set('bot:presence', {
      text,
      typeName,
      updatedAt: Date.now(),
    });

    return interaction.reply({
      content: `Saved status: **${typeName}** — ${text}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
