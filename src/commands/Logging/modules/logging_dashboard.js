import { EmbedBuilder } from 'discord.js';
import { getLoggingStatus, getIgnoreList } from '../../../services/loggingService.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import {
  createLoggingDashboardComponents,
  createLoggingCategoryViewComponents,
  createLoggingFilterComponents,
  DASHBOARD_CATEGORY_LABELS,
} from '../../../utils/logging/loggingUi.js';

function channelMention(id) {
  return id ? `<#${id}>` : '*Not set*';
}

export async function buildLoggingDashboardView(interaction, client) {
  const status = await getLoggingStatus(client, interaction.guildId);
  const config = await getGuildConfig(client, interaction.guildId);
  const channels = config?.logging?.channels || config?.logChannels || {};

  const embed = new EmbedBuilder()
    .setTitle('📋 Logging Dashboard')
    .setColor(status.enabled ? 0x57f287 : 0xed4245)
    .setDescription(
      status.enabled
        ? 'Audit logging is **enabled**.'
        : 'Audit logging is **disabled**.',
    )
    .addFields(
      {
        name: 'Audit channel',
        value: channelMention(channels.audit || channels.moderation),
        inline: true,
      },
      {
        name: 'Applications',
        value: channelMention(channels.applications),
        inline: true,
      },
      {
        name: 'Reports',
        value: channelMention(channels.reports),
        inline: true,
      },
    )
    .setFooter({ text: 'Use the menu below to configure channels and events.' });

  const components = createLoggingDashboardComponents(
    status.enabledEvents || {},
    Boolean(status.enabled),
  );

  return { embed, components };
}

export async function buildLoggingCategoriesView(interaction, client) {
  const status = await getLoggingStatus(client, interaction.guildId);

  const embed = new EmbedBuilder()
    .setTitle('📋 Event Categories')
    .setColor(0x5865f2)
    .setDescription(
      'Toggle which event categories are logged.\nGreen = on · Red = off',
    )
    .setFooter({ text: 'Categories view' });

  const components = createLoggingCategoryViewComponents(
    status.enabledEvents || {},
    Boolean(status.enabled),
  );

  return { embed, components };
}

export async function buildLoggingFilterView(interaction, client) {
  const config = await getGuildConfig(client, interaction.guildId);
  const ignore = typeof getIgnoreList === 'function'
    ? getIgnoreList(config)
    : config?.logging?.ignore || { users: [], channels: [] };

  const users = (ignore.users || []).map((id) => `<@${id}>`).join(', ') || '*None*';
  const channels = (ignore.channels || []).map((id) => `<#${id}>`).join(', ') || '*None*';

  const embed = new EmbedBuilder()
    .setTitle('🔇 Ignore Filters')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Ignored users', value: users.slice(0, 1024) },
      { name: 'Ignored channels', value: channels.slice(0, 1024) },
    )
    .setFooter({ text: 'Filters view' });

  const components = createLoggingFilterComponents();
  return { embed, components };
}

export function isCategoriesView(interaction) {
  const footer = interaction.message?.embeds?.[0]?.footer?.text || '';
  return footer.includes('Categories');
}

export function isFilterView(interaction) {
  const footer = interaction.message?.embeds?.[0]?.footer?.text || '';
  return footer.includes('Filters');
}

export async function refreshDashboardMessage(interaction, client) {
  try {
    let view;
    if (isCategoriesView(interaction)) {
      view = await buildLoggingCategoriesView(interaction, client);
    } else if (isFilterView(interaction)) {
      view = await buildLoggingFilterView(interaction, client);
    } else {
      view = await buildLoggingDashboardView(interaction, client);
    }
    await interaction.message.edit({
      embeds: [view.embed],
      components: view.components,
      content: null,
    });
  } catch {
    // message may be gone
  }
}
