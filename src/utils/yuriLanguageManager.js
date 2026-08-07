import { getFromDb, setInDb } from './database.js';

const LANG_KEY = (userId) => `user:lang:${userId}`;

export async function setUserLanguage(userId, language) {
  const allowed = ['english', 'tagalog', 'bisaya'];
  if (!allowed.includes(language)) return false;
  await setInDb(LANG_KEY(userId), language);
  return true;
}

export async function getUserLanguage(userId) {
  const lang = await getFromDb(LANG_KEY(userId), 'english');
  return lang || 'english';
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ english: string, tagalog: string, bisaya: string }} translations
 * @param {boolean} isPublic
 */
export async function sendYuriResponse(interaction, translations, isPublic = false) {
  if (isPublic) {
    return interaction.reply({
      content: translations.english,
      ephemeral: false,
    });
  }

  const userLang = await getUserLanguage(interaction.user.id);
  const content = translations[userLang] || translations.english;

  return interaction.reply({
    content,
    ephemeral: true,
  });
}
