import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Post the custom verification panel (Age → Gender → Rank)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Channel to post the verification panel in')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel');

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('✅ Server Verification')
      .setDescription(
        [
          'Welcome to **BANORANT**!',
          '',
          'Complete these **3 steps** to get access:',
          '**1.** Age',
          '**2.** Gender',
          '**3.** Valorant rank',
          '',
          'Select your **age** below to start.',
        ].join('\n'),
      )
      .setFooter({ text: "Yuri's Chamber" });

    const ageMenu = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('verify_age')
        .setPlaceholder('Select your age...')
        .addOptions(
          { label: '13-17', value: 'age_13_17', emoji: '🟢' },
          { label: '18-23', value: 'age_18_23', emoji: '🟡' },
          { label: '24+', value: 'age_24', emoji: '🔴' },
        ),
    );

    await channel.send({
      embeds: [embed],
      components: [ageMenu],
    });

    await interaction.reply({
      content: `✅ Verification panel posted in ${channel}.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
