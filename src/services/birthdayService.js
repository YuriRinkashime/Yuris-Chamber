import { getGuildConfig } from './config/guildConfig.js';
import {
  getGuildBirthdays,
  setBirthday as dbSetBirthday,
  deleteBirthday as dbDeleteBirthday,
  getMonthName,
  getBirthdayTrackingKey,
} from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { YurisChamberError, ErrorTypes } from '../utils/errorHandler.js';

const AGE_ROLES = ['13-17', '18-23', '24+'];

export function validateBirthday(month, day, year = null) {
  if (typeof month !== 'number' || typeof day !== 'number') {
    return { isValid: false, error: 'Month and day must be numbers' };
  }
  if (month < 1 || month > 12) {
    return { isValid: false, error: 'Month must be between 1 and 12' };
  }
  if (day < 1 || day > 31) {
    return { isValid: false, error: 'Day must be between 1 and 31' };
  }

  const checkYear = year || new Date().getFullYear();
  const date = new Date(checkYear, month - 1, day);
  if (isNaN(date.getTime()) || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return { isValid: false, error: 'Invalid date (check month/day)' };
  }

  if (year != null) {
    if (typeof year !== 'number' || year < 1950 || year > new Date().getFullYear() - 13) {
      return { isValid: false, error: 'Year looks invalid (must be 13+)' };
    }
  }

  return { isValid: true };
}

export function ageFromYMD(year, month, day) {
  const now = new Date();
  let age = now.getFullYear() - year;
  const m = now.getMonth() + 1;
  const d = now.getDate();
  if (m < month || (m === month && d < day)) age--;
  return age;
}

export function ageRoleName(age) {
  if (age >= 24) return '24+';
  if (age >= 18) return '18-23';
  if (age >= 13) return '13-17';
  return null;
}

export async function applyAgeRole(member, year, month, day) {
  if (!year) return null;
  const age = ageFromYMD(year, month, day);
  const roleName = ageRoleName(age);
  if (!roleName) return null;

  const guild = member.guild;
  const me = guild.members.me;
  if (!me?.permissions.has('ManageRoles')) return roleName;

  const role = guild.roles.cache.find((r) => r.name === roleName);
  if (!role || role.position >= me.roles.highest.position) return roleName;

  const toRemove = member.roles.cache.filter((r) => AGE_ROLES.includes(r.name));
  if (toRemove.size) await member.roles.remove(toRemove).catch(() => {});
  await member.roles.add(role).catch(() => {});
  return roleName;
}

export async function setBirthday(client, guildId, userId, month, day, year = null) {
  const validation = validateBirthday(month, day, year);
  if (!validation.isValid) {
    throw new YurisChamberError(
      validation.error,
      ErrorTypes.VALIDATION,
      validation.error,
      { month, day, year, userId, guildId },
    );
  }

  const success = await dbSetBirthday(client, guildId, userId, month, day, year);
  if (!success) {
    throw new YurisChamberError(
      'Failed to save birthday',
      ErrorTypes.DATABASE,
      'Failed to set your birthday. Try again later.',
      { userId, guildId },
    );
  }

  return {
    data: {
      month,
      day,
      year,
      monthName: getMonthName(month),
      age: year ? ageFromYMD(year, month, day) : null,
      roleName: year ? ageRoleName(ageFromYMD(year, month, day)) : null,
    },
  };
}

export async function getUserBirthday(client, guildId, userId) {
  const birthdays = await getGuildBirthdays(client, guildId);
  const birthdayData = birthdays[userId];
  if (!birthdayData) return null;

  return {
    month: birthdayData.month,
    day: birthdayData.day,
    year: birthdayData.year,
    monthName: getMonthName(birthdayData.month),
  };
}

export async function deleteBirthday(client, guildId, userId) {
  const birthday = await getUserBirthday(client, guildId, userId);
  if (!birthday) return { status: 'not_found' };

  const success = await dbDeleteBirthday(client, guildId, userId);
  if (!success) {
    throw new YurisChamberError(
      'Failed to delete birthday',
      ErrorTypes.DATABASE,
      'Failed to remove your birthday.',
      { userId, guildId },
    );
  }
  return { status: 'removed' };
}

export async function checkBirthdays(client) {
  const today = new Date();
  const currentMonth = today.getUTCMonth() + 1;
  const currentDay = today.getUTCDate();

  for (const [guildId, guild] of client.guilds.cache) {
    try {
      const config = await getGuildConfig(client, guildId);
      const { birthdayChannelId, birthdayRoleId } = config || {};

      const birthdays = (await getGuildBirthdays(client, guildId)) || {};
      const birthdayMembers = [];

      for (const [userId, userData] of Object.entries(birthdays)) {
        if (userData.month !== currentMonth || userData.day !== currentDay) continue;

        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) continue;

        birthdayMembers.push(member);

        // Age role upgrade (needs year saved)
        if (userData.year) {
          await applyAgeRole(member, userData.year, userData.month, userData.day);
        }

        // Optional one-day "birthday" role
        if (birthdayRoleId) {
          await member.roles.add(birthdayRoleId, 'Happy Birthday').catch(() => {});
        }
      }

      if (birthdayMembers.length > 0 && birthdayChannelId) {
        const channel = await guild.channels.fetch(birthdayChannelId).catch(() => null);
        if (channel) {
          const mentionList = birthdayMembers.map((m) => m.toString()).join(', ');
          await channel.send({
            embeds: [
              {
                title: '🎉 Happy Birthday!',
                description: `Happy birthday to ${mentionList}! 🎂`,
                color: 0xff69b4,
                timestamp: new Date(),
              },
            ],
          });
        }
      }
    } catch (error) {
      logger.error(`Birthday check failed for guild ${guildId}:`, error);
    }
  }
}
