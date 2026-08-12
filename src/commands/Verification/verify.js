import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} from 'discord.js';
import {
  getVerifyConfig,
  saveVerifyConfig,
  resetVerifyConfig,
  slugValue,
} from '../../services/verifyConfig.js';

function ageMenu(config) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('verify_age')
      .setPlaceholder('Select your age...')
      .addOptions(
        config.ages.map((o) => ({
          label: o.label.slice(0, 100),
          value: o.value,
          emoji: o.emoji || undefined,
          description: o.description,
        })),
      ),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verification panel & customization (Admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) =>
      s
        .setName('post')
        .setDescription('Post the verification panel')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Channel for the panel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s.setName('list').setDescription('Show current age / gender / rank options'),
    )
    .addSubcommand((s) =>
      s
        .setName('add-rank')
        .setDescription('Add a rank/activity option (and create role if missing)')
        .addStringOption((o) =>
          o.setName('name').setDescription('Display & role name').setRequired(true).setMaxLength(100),
        )
        .addStringOption((o) =>
          o.setName('emoji').setDescription('Optional emoji').setRequired(false),
        )
        .addStringOption((o) =>
          o.setName('description').setDescription('Optional select description').setRequired(false),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remove-rank')
        .setDescription('Remove a rank/activity option by name')
        .addStringOption((o) =>
          o.setName('name').setDescription('Exact option/role name').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('set-panel')
        .setDescription('Customize panel title/description')
        .addStringOption((o) =>
          o.setName('title').setDescription('Embed title').setRequired(false).setMaxLength(200),
        )
        .addStringOption((o) =>
          o
            .setName('description')
            .setDescription('Embed description (use \\n for new lines)')
            .setRequired(false)
            .setMaxLength(1000),
        ),
    )
    .addSubcommand((s) =>
      s.setName('reset').setDescription('Reset options to BANORANT defaults (incl. Unranked & non-Valo)'),
    ),

  category: 'verification',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const client = interaction.client;
    const guildId = interaction.guildId;

    if (sub === 'list') {
      const cfg = await getVerifyConfig(client, guildId);
      const fmt = (arr) =>
        arr.map((o) => `• ${o.emoji || ''} **${o.label}** → role \`${o.roleName}\``).join('\n') ||
        '_none_';
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff4655)
            .setTitle('Verification options')
            .addFields(
              { name: 'Ages', value: fmt(cfg.ages).slice(0, 1024) },
              { name: 'Genders', value: fmt(cfg.genders).slice(0, 1024) },
              { name: 'Ranks / activity', value: fmt(cfg.ranks).slice(0, 1024) },
            )
            .setFooter({ text: 'Edits apply to new verify steps · re-post panel if needed' }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'reset') {
      await resetVerifyConfig(client, guildId);
      return interaction.reply({
        content:
          '✅ Verification options reset to defaults (includes **Unranked** & **Doesn\'t Play Valo**).\n' +
          'Run `/setroles create-ranks` to create missing roles, then `/verify post`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'set-panel') {
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      const partial = {};
      if (title) partial.panelTitle = title;
      if (description) partial.panelDescription = description.replace(/\\n/g, '\n');
      if (!Object.keys(partial).length) {
        return interaction.reply({
          content: 'Provide title and/or description.',
          flags: MessageFlags.Ephemeral,
        });
      }
      await saveVerifyConfig(client, guildId, partial);
      return interaction.reply({
        content: '✅ Panel text saved. Use `/verify post` to re-post.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'add-rank') {
      const name = interaction.options.getString('name').trim();
      const emoji = interaction.options.getString('emoji') || undefined;
      const description = interaction.options.getString('description') || undefined;
      const cfg = await getVerifyConfig(client, guildId);
      if (cfg.ranks.length >= 25) {
        return interaction.reply({
          content: 'Max 25 rank options (Discord limit).',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (cfg.ranks.some((r) => r.roleName.toLowerCase() === name.toLowerCase())) {
        return interaction.reply({
          content: 'That rank/option already exists.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const value = slugValue('rank', name);
      cfg.ranks.push({ label: name, value, roleName: name, emoji, description });
      await saveVerifyConfig(client, guildId, { ranks: cfg.ranks });

      // create role if missing
      let roleNote = '';
      const exists = interaction.guild.roles.cache.find((r) => r.name === name);
      if (!exists) {
        try {
          await interaction.guild.roles.create({
            name,
            reason: `verify add-rank by ${interaction.user.tag}`,
          });
          roleNote = ' Role created.';
        } catch (e) {
          roleNote = ` (Could not create role: ${e.message})`;
        }
      }
      return interaction.reply({
        content: `✅ Added rank/activity **${name}**.${roleNote}\nNew verifications will show it. Re-post panel optional.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'remove-rank') {
      const name = interaction.options.getString('name').trim();
      const cfg = await getVerifyConfig(client, guildId);
      const next = cfg.ranks.filter((r) => r.roleName.toLowerCase() !== name.toLowerCase());
      if (next.length === cfg.ranks.length) {
        return interaction.reply({
          content: 'No rank option with that name.',
          flags: MessageFlags.Ephemeral,
        });
      }
      await saveVerifyConfig(client, guildId, { ranks: next });
      return interaction.reply({
        content: `✅ Removed **${name}** from verification options (Discord role not deleted).`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // post
    const channel = interaction.options.getChannel('channel');
    const cfg = await getVerifyConfig(client, guildId);
    const embed = new EmbedBuilder()
      .setColor(0xff4655)
      .setTitle(cfg.panelTitle)
      .setDescription(cfg.panelDescription)
      .setFooter({ text: "Yuri's Chamber · BANORANT CAFE" })
      .setTimestamp();

    await channel.send({
      embeds: [embed],
      components: [ageMenu(cfg)],
    });

    return interaction.reply({
      content: `✅ Verification panel posted in ${channel}.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
