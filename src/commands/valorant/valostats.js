import { SlashCommandBuilder } from 'discord.js';
import { sendYuriResponse } from '../../utils/yuriLanguageManager.js';

export default {
    data: new SlashCommandBuilder()
        .setName('valostats')
        .setDescription('Check your current Valorant statistics.')
        .addBooleanOption(option =>
            option.setName('public')
                .setDescription('Do you want everyone in the server to see this?')
                .setRequired(true)
        ),
    async execute(interaction) {
        const isPublic = interaction.options.getBoolean('public');

        const translations = {
            english: 'Here are your Valorant stats: (coming soon – link your account with /login)',
            tagalog: 'Narito ang iyong mga stats sa Valorant: (malapit na – i-link ang account mo gamit ang /login)',
            bisaya: 'Kini ang imong Valorant stats: (soon pa – i-link ang account nimo gamit ang /login)',
        };

        await sendYuriResponse(interaction, translations, isPublic);
    },
};
