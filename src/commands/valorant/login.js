import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('login')
    .setDescription('Link your Riot account (for future daily shop & stats)'),

  async execute(interaction) {
    const userId = interaction.user.id;
    // IMPORTANT: replace with your real Railway public domain
    const redirectUri = encodeURIComponent('https://yuris-chamber-production.up.railway.app/auth/callback');
    
    const authUrl = `https://auth.riotgames.com/authorize?client_id=play-valorant-web-prod&response_type=token%20id_token&redirect_uri=${redirectUri}&scope=account%20openid&state=${userId}`;

    const embed = new EmbedBuilder()
      .setTitle('/// YURI_SYSTEM: RIOT AUTH')
      .setDescription('Click the button to link your Riot account.\n\nThis is currently for future features (shop / stats).')
      .setColor('#00FF00');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Authenticate with Riot')
        .setStyle(ButtonStyle.Link)
        .setURL(authUrl)
    );

    await interaction.reply({
      embeds: [embed],
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  },
};
