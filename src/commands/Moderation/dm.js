import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { sanitizeMarkdown } from '../../utils/validation.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

export default {
  data: new SlashCommandBuilder()
    .setName('dm')
    .setDescription('Send a direct message to a user (Staff only)')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to send a DM to')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('The message to send')
        .setRequired(true)
        .setMaxLength(2000),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),

  category: 'moderation',

  async execute(interaction) {
    // Ephemeral = only YOU see bot replies in the server
    const deferSuccess = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral,
    });
    if (!deferSuccess) return;

    const targetUser = interaction.options.getUser('user');
    const message = interaction.options.getString('message');

    try {
      if (targetUser.bot) {
        return replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: 'You cannot send DMs to bot accounts.',
        });
      }

      const sanitized = sanitizeMarkdown(message);
      const dmChannel = await targetUser.createDM();

      // Plain text only — no "Message from ..." header
      await dmChannel.send({ content: sanitized });

      // Optional: staff log channel only (not a public chat message)
      await logEvent({
        client: interaction.client,
        guild: interaction.guild,
        event: {
          action: 'DM Sent',
          target: `${targetUser.tag} (${targetUser.id})`,
          executor: `${interaction.user.tag} (${interaction.user.id})`,
          reason: 'Staff DM',
          metadata: {
            userId: targetUser.id,
            moderatorId: interaction.user.id,
            messageLength: sanitized.length,
          },
        },
      }).catch(() => {});

      return InteractionHelper.safeEditReply(interaction, {
        content: `✅ DM sent to **${targetUser.tag}**.`,
      });
    } catch (error) {
      logger.error('DM command error:', error);

      if (error.code === 50007) {
        return replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: `Could not DM **${targetUser.tag}**. They may have DMs disabled.`,
        });
      }

      return replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: `Failed to send DM: ${error.message}`,
      });
    }
  },
};
