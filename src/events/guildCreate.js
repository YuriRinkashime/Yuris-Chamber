import { Events } from 'discord.js';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

function dashboardBaseUrl() {
  const raw =
    process.env.DASHBOARD_PUBLIC_URL ||
    process.env.PUBLIC_URL ||
    process.env.DASHBOARD_URL ||
    '';
  if (raw) return String(raw).replace(/\/+$/, '');
  // bot-hosting style fallback
  const host = process.env.HOST || '';
  if (host) return `https://${host}`;
  return '';
}

export default {
  name: Events.GuildCreate,
  once: false,

  async execute(guild) {
    try {
      const client = guild.client;
      const owner = await guild.fetchOwner().catch(() => null);
      if (!owner?.user) {
        logger.warn(`GuildCreate ${guild.id}: no owner`);
        return;
      }

      // Don't spam bot owner accounts
      const owners = String(process.env.OWNER_IDS || '')
        .split(/[,\s]+/)
        .filter(Boolean);
      if (owners.includes(owner.id)) {
        logger.info(`Joined ${guild.name} (bot owner is server owner) — skip onboarding DM`);
        return;
      }

      const token = crypto.randomBytes(16).toString('hex');
      const invite = {
        token,
        guildId: guild.id,
        guildName: guild.name,
        ownerId: owner.id,
        used: false,
        createdAt: Date.now(),
      };
      if (client.db) {
        await client.db.set(`dashboard:invite:${token}`, invite);
      }

      const base = dashboardBaseUrl();
      const basePath = process.env.DASHBOARD_BASE || '/panel';
      const link = base
        ? `${base}${basePath}/register?token=${token}`
        : `(open your bot dashboard) /register?token=${token}`;

      const text =
        `Thanks for adding **Yuri's Chamber** to **${guild.name}**.\n\n` +
        `You're the server owner — you can manage **your server only** (commands, welcome/goodbye, polls, giveaways).\n` +
        `You **cannot** change global bot settings (AI keys, maintenance, restarts, bot DMs).\n\n` +
        `Create your manager account here:\n${link}\n\n` +
        `Already have an account? Log in on the dashboard and ask the bot owner to link this server.`;

      await owner.send({ content: text }).catch((e) => {
        logger.warn(`Could not DM owner of ${guild.name}: ${e.message}`);
      });
      logger.info(`Onboarding DM sent for guild ${guild.name} (${guild.id})`);
    } catch (e) {
      logger.error('guildCreate onboarding:', e?.message || e);
    }
  },
};
