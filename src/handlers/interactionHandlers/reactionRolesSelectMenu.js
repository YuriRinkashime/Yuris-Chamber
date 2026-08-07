import { EmbedBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { getColor } from '../../config/bot.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';
import { getReactionRoleMessage } from '../../services/reactionRoleService.js';

// ======================================================
// OPTIONAL: Hardcoded role map for simple panels
// Fill these with your real Discord Role IDs
// Leave empty if you only use the /reactroles system
// ======================================================
const SIMPLE_ROLE_MAP = {
  // Age
  age_13_15: '',          // e.g. '123456789012345678'
  age_16_17: '',
  age_18: '',

  // Gender
  gender_male: '',
  gender_female: '',
  gender_other: '',

  // Valorant Rank
  rank_iron: '',
  rank_bronze: '',
  rank_silver: '',
  rank_gold: '',
  rank_platinum: '',
  rank_diamond: '',
  rank_ascendant: '',
  rank_immortal: '',
  rank_radiant: '',
};

export async function handleReactionRolesSelectMenu(interaction, client) {
  try {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral,
    });
    if (!deferSuccess) return;

    if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
      throw createError(
        'Reaction role interaction used outside a guild context',
        ErrorTypes.VALIDATION,
        'This menu can only be used inside a server.',
        { userId: interaction.user.id }
      );
    }

    const member = interaction.member;
    const selectedValues = interaction.values; // array of selected values
    const customId = interaction.customId;

    // --------------------------------------------------
    // 1. Try the existing YurisChamber reaction-role system first
    // --------------------------------------------------
    const reactionRoleData = await getReactionRoleMessage(
      client,
      interaction.guildId,
      interaction.message.id
    );

    let availableRoleIds = [];
    let isSimpleMode = false;

    if (reactionRoleData) {
      // Normal YurisChamber system
      availableRoleIds = Array.isArray(reactionRoleData.roles)
        ? reactionRoleData.roles
        : typeof reactionRoleData.roles === 'object'
          ? Object.values(reactionRoleData.roles)
          : [];
    } else if (customId.startsWith('role_')) {
      // Fallback: simple hardcoded panels (age / gender / rank)
      isSimpleMode = true;

      // Only allow roles that belong to the same group
      const group = customId.replace('role_', ''); // age | gender | rank
      availableRoleIds = Object.entries(SIMPLE_ROLE_MAP)
        .filter(([key, id]) => key.startsWith(group) && id)
        .map(([, id]) => id);
    } else {
      // Unknown menu
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setDescription('❌ This role menu is no longer active or is not configured.')
            .setColor(getColor('error')),
        ],
      });
    }

    if (availableRoleIds.length === 0) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setDescription('❌ No roles are configured for this menu yet.')
            .setColor(getColor('error')),
        ],
      });
    }

    // --------------------------------------------------
    // Permission & hierarchy checks
    // --------------------------------------------------
    const me =
      interaction.guild.members.me ??
      (await interaction.guild.members.fetchMe().catch(() => null));

    if (!me) {
      throw createError(
        'Unable to fetch bot member',
        ErrorTypes.PERMISSION,
        'I could not verify my permissions. Please try again.',
        { guildId: interaction.guildId }
      );
    }

    if (!me.permissions.has('ManageRoles')) {
      throw createError(
        'Bot missing ManageRoles',
        ErrorTypes.PERMISSION,
        'I do not have permission to manage roles in this server.',
        { guildId: interaction.guildId }
      );
    }

    const botRolePosition = me.roles.highest.position;

    const addedRoles = [];
    const removedRoles = [];
    const skippedRoles = [];

    // --------------------------------------------------
    // Add the roles the user selected
    // --------------------------------------------------
    for (const value of selectedValues) {
      // In simple mode the value is like "age_18", in normal mode it is a role ID
      const roleId = isSimpleMode ? SIMPLE_ROLE_MAP[value] : value;

      if (!roleId || !availableRoleIds.includes(roleId)) continue;

      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) {
        skippedRoles.push(roleId);
        continue;
      }

      // Safety: block dangerous / managed roles
      const isDangerous = role.permissions.has([
        'Administrator',
        'ManageGuild',
        'ManageRoles',
        'ManageChannels',
        'ManageWebhooks',
        'BanMembers',
        'KickMembers',
        'MentionEveryone',
      ]);

      if (role.managed || isDangerous) {
        logger.warn(`Blocked protected role: ${role.name}`);
        skippedRoles.push(role.name);
        continue;
      }

      if (role.position >= botRolePosition) {
        logger.warn(`Hierarchy issue with role: ${role.name}`);
        skippedRoles.push(role.name);
        continue;
      }

      if (!member.roles.cache.has(roleId)) {
        try {
          await member.roles.add(role);
          addedRoles.push(role.name);
        } catch (err) {
          logger.error(`Failed to add ${role.name}:`, err);
          skippedRoles.push(role.name);
        }
      }
    }

    // --------------------------------------------------
    // Remove the other roles from the same group (exclusive)
    // --------------------------------------------------
    for (const roleId of availableRoleIds) {
      // Skip if this role was just selected
      const wasSelected = isSimpleMode
        ? selectedValues.some((v) => SIMPLE_ROLE_MAP[v] === roleId)
        : selectedValues.includes(roleId);

      if (wasSelected) continue;

      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) continue;
      if (role.position >= botRolePosition) continue;

      if (member.roles.cache.has(roleId)) {
        try {
          await member.roles.remove(role);
          removedRoles.push(role.name);
        } catch (err) {
          logger.error(`Failed to remove ${role.name}:`, err);
        }
      }
    }

    // --------------------------------------------------
    // Build response
    // --------------------------------------------------
    let description = '🎭 **Roles updated!**\n\n';

    if (addedRoles.length > 0) {
      description += `✅ **Added:** ${addedRoles.map((n) => `**${n}**`).join(', ')}\n`;
    }
    if (removedRoles.length > 0) {
      description += `❌ **Removed:** ${removedRoles.map((n) => `**${n}**`).join(', ')}\n`;
    }
    if (addedRoles.length === 0 && removedRoles.length === 0) {
      description += 'No changes were made.';
    }
    if (skippedRoles.length > 0) {
      description += `\n⚠️ **Skipped:** ${skippedRoles.join(', ')} (permission / hierarchy)`;
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setDescription(description)
          .setColor(getColor('success'))
          .setTimestamp(),
      ],
    });

    // Optional logging
    if (addedRoles.length > 0 || removedRoles.length > 0) {
      try {
        await logEvent({
          client,
          guildId: interaction.guildId,
          eventType: EVENT_TYPES.REACTION_ROLE_UPDATE,
          data: {
            description: `Roles updated for ${member.user.tag}`,
            userId: member.user.id,
            channelId: interaction.channelId,
            fields: [
              {
                name: '👤 Member',
                value: `${member.user.tag} (${member.user.id})`,
                inline: false,
              },
              ...(addedRoles.length
                ? [{ name: '✅ Added', value: addedRoles.join(', '), inline: false }]
                : []),
              ...(removedRoles.length
                ? [{ name: '❌ Removed', value: removedRoles.join(', '), inline: false }]
                : []),
            ],
          },
        });
      } catch (logErr) {
        logger.warn('Failed to log role update:', logErr);
      }
    }

    logger.info(
      `Roles updated for ${member.user.tag}: +${addedRoles.length} -${removedRoles.length}`
    );
  } catch (error) {
    await handleInteractionError(interaction, error, {
      type: 'select_menu',
      customId: interaction.customId || 'reaction_roles',
    });
  }
}
