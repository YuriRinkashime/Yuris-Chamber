import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getLevelingConfig, getUserLevelData } from '../services/leveling/leveling.js';
import { addXp } from '../services/leveling/xpSystem.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { parsePrefixCommand } from '../utils/prefixParser.js';
import { supportsPrefixExecution, executePrefixCommand, resolvePrefixAccessKey } from '../utils/messageAdapter.js';
import { resolveCommandAlias, resolveSubcommandAlias } from '../config/commands/commandAliases.js';
import { getPrefixRestriction } from '../config/commands/prefixRestrictions.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getCommandPrefix, getBotMessage, isBotOwner, isCommandCategoryEnabled, isMaintenanceMode } from '../config/bot.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { createEmbed } from '../utils/embeds.js';
import { isCommandEnabled } from '../services/commandAccessService.js';

const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;
const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;

export default {
  name: Events.MessageCreate,
    async execute(message, client) {
    try {
      // Ignore other bots only
          if (message.author.bot) return;

                  if (!message.guild) {
        try {
          const {
            appendUserDm,
            scheduleAutoAi,
            cancelAutoAi,
            upsertOwnerNotify } = await import('../services/dmInboxService.js');
          const { isBotOwner } = await import('../config/bot.js');

          const content = message.content?.trim();
          if (!content) return;

          cancelAutoAi(message.author.id);
          await appendUserDm(client, message.author, content);
          scheduleAutoAi(client, message.author.id);

          // ALWAYS refresh the Discord card (even if sender is owner — for testing)
          await upsertOwnerNotify(client, message.author.id, {
            disableButtons: false,
            footer: 'New message · AI reply or your words' });

          // Don't also spam other owners if the sender is an owner
          // (upsert already DMs/edits for OWNER_IDS)
          return;
        } catch (e) {
          logger.error('DM inbox error:', e);
        }
        return;
      }

      // ===== Guild messages only below this line =====

      if (!message.guild) return;

            // AI: reply-to-bot OR @mention the bot → answer with AI
      try {
        const contentTrim = message.content?.trim() || '';
        if (contentTrim) {
          let triggered = false;

          // 1) User replied to any message from this bot
          if (message.reference?.messageId) {
            const ref = await message.channel.messages
              .fetch(message.reference.messageId)
              .catch(() => null);
            if (ref && ref.author?.id === client.user.id) {
              triggered = true;
            }
          }

          // 2) User @mentioned the bot
          if (
            message.mentions?.users?.has(client.user.id) ||
            message.mentions?.repliedUser?.id === client.user.id
          ) {
            triggered = true;
          }

          if (triggered) {
            const {
              getAiConfig,
              generateReply,
              getUserAiHistory,
              saveUserAiHistory,
              buildSystemInstructions,
              saveUserAiPrefs,
            } = await import('../services/aiService.js');

            const guildId = message.guild.id;
            const userId = message.author.id;
            const config = await getAiConfig(client, guildId);

            if (config.enabled) {
              // Strip bot mention from text so the model doesn't see raw <@botid>
              let userMessage = contentTrim
                .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
                .trim()
                .slice(0, 1500);
              if (!userMessage) userMessage = 'hey';

              const lower = userMessage.toLowerCase();

              if (/\b(bisaya|cebuano)\b/i.test(userMessage) && /\b(yes|oo|sige|please|from now|bet|go)\b/i.test(lower)) {
                await saveUserAiPrefs(client, guildId, userId, { language: 'ceb' });
              }
              if (/\b(tagalog|filipino)\b/i.test(userMessage) && /\b(yes|oo|sige|please|from now|bet|go)\b/i.test(lower)) {
                await saveUserAiPrefs(client, guildId, userId, { language: 'tl' });
              }
              if (/\b(english)\b/i.test(userMessage) && /\b(yes|please|from now|bet|go)\b/i.test(lower)) {
                await saveUserAiPrefs(client, guildId, userId, { language: 'en' });
              }
              if (/\b(personal(ize)?|custom(ize)?|be my ai)\b/i.test(lower)) {
                await saveUserAiPrefs(client, guildId, userId, {
                  customStyle: userMessage.slice(0, 800),
                });
              }
              if (/\b(reset (style|personality|ai)|default yuri)\b/i.test(lower)) {
                await saveUserAiPrefs(client, guildId, userId, { customStyle: null });
              }

              // Optional: "reply in #channel" / "message me in #channel"
              let targetChannel = message.channel;
              const chMention = userMessage.match(/<#(\d{17,20})>/);
              const wantsOtherChannel =
                /\b(reply (me )?(in|at|on)|answer (me )?(in|at|on)|talk (to me )?(in|at|on)|message me (in|at|on)|go to)\b/i.test(
                  lower,
                ) && chMention;

              if (wantsOtherChannel) {
                const dest = await message.guild.channels
                  .fetch(chMention[1])
                  .catch(() => null);
                if (dest?.isTextBased?.()) {
                  const me = message.guild.members.me;
                  const perms = dest.permissionsFor(me);
                  if (perms?.has(['ViewChannel', 'SendMessages'])) {
                    targetChannel = dest;
                  }
                }
              }

              const history = await getUserAiHistory(client, guildId, userId);
              let systemInstructions = await buildSystemInstructions(
                client,
                guildId,
                userId,
                config.systemInstructions,
              );
              systemInstructions +=
                `\n\nCurrent speaker: ${message.author.username} (ID ${userId}). ` +
                `They are chatting in #${message.channel.name}. ` +
                `To mention them write <@${userId}>. Never write USER_ID as a placeholder. ` +
                `Reply naturally — more than one word when it fits. Avoid only saying "got it".`;

              if (targetChannel.id !== message.channel.id) {
                systemInstructions +=
                  `\nThey asked you to continue in #${targetChannel.name}. Answer their question fully; the bot will post there.`;
              }

              let answer = await generateReply({
                systemInstructions,
                userMessage,
                model: config.model,
                history,
              });

              answer = String(answer || '')
                .replace(/<@USER_ID>/gi, `<@${userId}>`)
                .replace(/@USER_ID\b/gi, `<@${userId}>`)
                .replace(/(^|[^<])@(\d{17,20})\b/g, (_, a, id) => `${a}<@${id}>`);
              if (answer.length > 1800) answer = answer.slice(0, 1800) + '...';
              if (!answer.trim()) answer = 'yo, say that again?';

              await saveUserAiHistory(client, guildId, userId, [
                ...history,
                { role: 'user', parts: [{ text: userMessage }] },
                { role: 'model', parts: [{ text: answer }] },
              ]);

              const mentionIds = [
                ...answer.matchAll(/<@!?(\d{17,20})>/g),
              ].map((m) => m[1]);

              const payload = {
                content: answer,
                allowedMentions: {
                  users: mentionIds.length ? mentionIds : [],
                },
              };

              if (targetChannel.id === message.channel.id) {
                await message.reply(payload).catch(() =>
                  targetChannel.send(payload).catch(() => {}),
                );
              } else {
                await targetChannel
                  .send({
                    content: `${answer}`,
                    allowedMentions: payload.allowedMentions,
                  })
                  .catch(() => {});
                await message
                  .reply({
                    content: `sent in ${targetChannel}`,
                    allowedMentions: { parse: [] },
                  })
                  .catch(() => {});
              }
              return;
            }
          }
        }
      } catch (err) {
        logger.debug('AI chat trigger failed:', err?.message);
      }

      // Channel locks (stored in Firebase via client.db)
      try {
        const locks =
          (await client.db.get(`guild:${message.guild.id}:channelLocks`, {})) || {};
        const lock = locks[message.channel.id];
        if (lock?.commands?.length) {
          const member = message.member;
          const isAdmin =
            member?.permissions?.has?.('Administrator') ||
            member?.permissions?.has?.('ManageMessages');
          if (!isAdmin && message.content?.trim()) {
            await message.delete().catch(() => {});
            return;
          }
        }
      } catch (err) {
        logger.debug('channel lock check failed:', err?.message);
      }

      await handlePrefixCommand(message, client);

      await handleLeveling(message, client);
    } catch (error) {
      logger.error('Error in messageCreate:', error);
    }
  } };

async function handlePrefixCommand(message, client) {
  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const prefix = guildConfig?.prefix || getCommandPrefix();
    const parsed = parsePrefixCommand(message.content, prefix);
    
    if (!parsed) {
      return; 
    }

    let { commandName, args } = parsed;
    const musicPrefixShortcut = commandName.toLowerCase();
    const MUSIC_PREFIX_SHORTCUTS = new Set(['leave', 'pause', 'resume', 'skip', 'stop', 'volume']);
    if (MUSIC_PREFIX_SHORTCUTS.has(musicPrefixShortcut)) {
      commandName = 'music';
      args = [musicPrefixShortcut, ...args];
    }

    logger.info(`Prefix command detected: ${commandName}, args: ${args.join(', ')}`);

    const resolvedCommandName = resolveCommandAlias(commandName);
    logger.info(`Resolved command name: ${resolvedCommandName}`);
    const command = client.commands.get(resolvedCommandName);

    if (!command) {
      logger.warn(`Command not found: ${resolvedCommandName}`);
      return; 
    }

    if (isMaintenanceMode() && !isBotOwner(message.author.id)) {
      await message.channel.send({
        embeds: [createEmbed({
          title: 'Maintenance Mode',
          description: getBotMessage('maintenanceMode'),
          color: 'warning' })] }).catch(() => {});
      return;
    }

    if (!isCommandCategoryEnabled(command.category)) {
      await message.channel.send({
        embeds: [createEmbed({
          title: 'Feature Disabled',
          description: getBotMessage('commandDisabled'),
          color: 'error' })] }).catch(() => {});
      return;
    }

    const restriction = getPrefixRestriction(command, args, resolveSubcommandAlias);
    if (!supportsPrefixExecution(command) || restriction.blocked) {
      if (restriction.blocked && restriction.reason) {
        const embed = createEmbed({
          title: 'Slash Command Only',
          description: `${restriction.reason}\nUse \`/${resolvedCommandName}\` instead.`,
          color: 'info' });
        await message.channel.send({ embeds: [embed] }).catch(() => {});
      }
      return;
    }

    if (!(await isCommandEnabled(client, message.guild.id, resolvePrefixAccessKey(command.data, args), command.category))) {
      const embed = createEmbed({
        title: 'Command Disabled',
        description: 'This command has been disabled for this server.',
        color: 'error' });
      await message.channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    const mockInteractionForProtection = {
      guildId: message.guild.id,
      user: message.author };
    const abuseProtection = await enforceAbuseProtection(
      mockInteractionForProtection,
      command,
      resolvedCommandName,
    );
    if (!abuseProtection.allowed) {
      const formattedCooldown = formatCooldownDuration(abuseProtection.remainingMs);
      const embed = createEmbed({
        title: 'Command Cooldown',
        description: `This command is on cooldown. Please wait ${formattedCooldown} before trying again.`,
        color: 'error' });
      await message.channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    logger.info(`Executing prefix command: ${prefix}${commandName} (resolved to ${resolvedCommandName}) by ${message.author.tag}`);
    
    await executePrefixCommand(command, message, args, client, prefix, guildConfig);
  } catch (error) {
    logger.error('Error handling prefix command:', error);
  }
}

async function handleLeveling(message, client) {
  try {
    const rateLimitKey = `xp-event:${message.guild.id}:${message.author.id}`;
    const canProcess = await checkRateLimit(rateLimitKey, MESSAGE_XP_RATE_LIMIT_ATTEMPTS, MESSAGE_XP_RATE_LIMIT_WINDOW_MS);
    if (!canProcess) {
      return;
    }

    const levelingConfig = await getLevelingConfig(client, message.guild.id);
    
    if (!levelingConfig?.enabled) {
      return;
    }

    if (levelingConfig.ignoredChannels?.includes(message.channel.id)) {
      return;
    }

    if (levelingConfig.ignoredRoles?.length > 0) {
      const member = await message.guild.members.fetch(message.author.id).catch(() => {
        return null;
      });
      if (member && member.roles.cache.some(role => levelingConfig.ignoredRoles.includes(role.id))) {
        return;
      }
    }

    if (levelingConfig.blacklistedUsers?.includes(message.author.id)) {
      return;
    }

    if (!message.content || message.content.trim().length === 0) {
      return;
    }

    const userData = await getUserLevelData(client, message.guild.id, message.author.id);

    const cooldownTime = levelingConfig.xpCooldown || 60;
    const now = Date.now();
    const timeSinceLastMessage = now - (userData.lastMessage || 0);

    if (timeSinceLastMessage < cooldownTime * 1000) {
      return;
    }

    const minXP = levelingConfig.xpRange?.min || levelingConfig.xpPerMessage?.min || 15;
    const maxXP = levelingConfig.xpRange?.max || levelingConfig.xpPerMessage?.max || 25;

    const safeMinXP = Math.max(1, minXP);
    const safeMaxXP = Math.max(safeMinXP, maxXP);

    const xpToGive = Math.floor(Math.random() * (safeMaxXP - safeMinXP + 1)) + safeMinXP;

    let finalXP = xpToGive;
    if (levelingConfig.xpMultiplier && levelingConfig.xpMultiplier > 1) {
      finalXP = Math.floor(finalXP * levelingConfig.xpMultiplier);
    }

    const result = await addXp(client, message.guild, message.member, finalXP);

    if (result?.leveledUp) {
      logger.info(
        `${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`
      );
    }
  } catch (error) {
    logger.error('Error handling leveling for message:', error);
  }
}
