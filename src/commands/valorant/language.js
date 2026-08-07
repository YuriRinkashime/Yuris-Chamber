import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { setUserLanguage } from '../../utils/yuriLanguageManager.js';

export default {
  data: new SlashCommandBuilder()
    .setName('language')
    .setDescription('Pili sa imong language / Pumili ng wika (Bisaya / Tagalog / English)')
    .addStringOption(opt =>
      opt.setName('lang')
        .setDescription('Language')
        .setRequired(true)
        .addChoices(
          { name: 'Bisaya', value: 'bisaya' },
          { name: 'Tagalog', value: 'tagalog' },
          { name: 'English', value: 'english' },
        )
    ),

  async execute(interaction) {
    const lang = interaction.options.getString('lang');
    await setUserLanguage(interaction.user.id, lang);

    const replies = {
      bisaya: 'Na-set na ang language nimo sa **Bisaya**!',
      tagalog: 'Naitakda na ang wika mo sa **Tagalog**!',
      english: 'Your language has been set to **English**!',
    };

    await interaction.reply({
      content: replies[lang],
      flags: MessageFlags.Ephemeral,
    });
  },
};
