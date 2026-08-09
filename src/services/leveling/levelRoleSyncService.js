import { logger } from '../../utils/logger.js';
import { getLevelingConfig, getUserLevelData, saveLevelingConfig } from './leveling.js';

import { getUserLevelPrefix } from '../../utils/database/keys.js';

async function listLevelUserIds(client, guildId) {
    if (!client.db) return [];
    const userIds = new Set();
    const prefixes = [
      getUserLevelPrefix(guildId),
      `guild:${guildId}:leveling:users:`,
      `${guildId}:leveling:users:`,
    ];

    // Prefer prefix list; also full scan fallback (Mongo)
    let keys = [];
    if (typeof client.db.list === 'function') {
      for (const prefix of prefixes) {
        const part = await client.db.list(prefix).catch(() => []);
        if (Array.isArray(part)) keys.push(...part);
      }
      if (keys.length === 0) {
        const all = await client.db.list('guild:').catch(() => []);
        if (Array.isArray(all)) {
          keys = all.filter(
            (k) =>
              typeof k === 'string' &&
              (k.includes(`:${guildId}:leveling:users:`) ||
                k.startsWith(`guild:${guildId}:leveling:users:`)),
          );
        }
      }
    }

    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const m = key.match(/leveling:users:(\d{17,20})$/);
      if (m) userIds.add(m[1]);
    }

    return [...userIds];
}

async function tryAwardRole(member, roleId, level) {
    const role = member.guild.roles.cache.get(roleId) || (await member.guild.roles.fetch(roleId).catch(() => null));
    if (!role || member.roles.cache.has(roleId)) return false;

    await member.roles.add(role, `Level ${level} reward (startup sync)`);
    return true;
}

export async function reconcileLevelRoles(client, guildId = null) {
    const summary = {
        scannedGuilds: 0,
        prunedRewardEntries: 0,
        rolesReAwarded: 0,
        errors: 0,
    };

    const guilds = guildId
        ? [client.guilds.cache.get(guildId)].filter(Boolean)
        : [...client.guilds.cache.values()];

    for (const guild of guilds) {
        summary.scannedGuilds += 1;

        try {
            const cfg = await getLevelingConfig(client, guild.id);
            if (cfg.enabled === false) continue;

            const rewards = { ...(cfg.roleRewards || {}) };
            if (Object.keys(rewards).length === 0) continue;

            let configChanged = false;

            for (const [level, roleId] of Object.entries(rewards)) {
                const role =
                    guild.roles.cache.get(roleId) || (await guild.roles.fetch(roleId).catch(() => null));
                if (!role) {
                    delete rewards[level];
                    configChanged = true;
                    summary.prunedRewardEntries += 1;
                    logger.warn(
                        `Removed missing level ${level} reward role ${roleId} from config in guild ${guild.id}`,
                    );
                }
            }

            if (configChanged) {
                cfg.roleRewards = rewards;
                await saveLevelingConfig(client, guild.id, cfg);
            }

            if (Object.keys(rewards).length === 0) continue;

            const userIds = await listLevelUserIds(client, guild.id);

            for (const userId of userIds) {
                const levelData = await getUserLevelData(client, guild.id, userId);
                const member = await guild.members.fetch(userId).catch(() => null);
                if (!member) continue;

                for (const [levelStr, roleId] of Object.entries(rewards)) {
                    const requiredLevel = Number(levelStr);
                    if (!Number.isFinite(requiredLevel) || levelData.level < requiredLevel) continue;

                    try {
                        const awarded = await tryAwardRole(member, roleId, requiredLevel);
                        if (awarded) summary.rolesReAwarded += 1;
                    } catch (awardError) {
                        summary.errors += 1;
                        logger.warn(
                            `Could not re-award level ${requiredLevel} role to ${userId} in guild ${guild.id}:`,
                            awardError.message,
                        );
                    }
                }
            }
        } catch (error) {
            summary.errors += 1;
            logger.warn(`Level role sync failed for guild ${guild.id}:`, error.message);
        }
    }

    return summary;
}
