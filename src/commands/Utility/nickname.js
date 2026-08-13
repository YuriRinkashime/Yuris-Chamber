import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getFromDb, setInDb } from '../../utils/database.js';

const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MAX_NICK = 32;

function nickKey(guildId, userId) {
  return `nickname:${guildId}:${userId}`;
}

function formatRemaining(ms) {
  if (ms <= 0) return '0m';
  const d = Math.floor(ms / (24 * 60 * 60 * 1000));
  const h = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const m = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || !parts.length) parts.push(`${m}m`);
  return parts.join(' ');
}

async function loadNickData(guildId, userId) {
  const data = await getFromDb(nickKey(guildId, userId), null);
  if (!data || typeof data !== 'object') {
    return { nickname: null, lastChangedAt: 0, history: [] };
  }
  return {
    nickname: data.nickname ?? null,
    lastChangedAt: Number(data.lastChangedAt) || 0,
    history: Array.isArray(data.history) ? data.history : [],
  };
}

async function saveNickData(guildId, userId, data) {
  await setInDb(nickKey(guildId, userId), {
    nickname: data.nickname ?? null,
    lastChangedAt: Number(data.lastChangedAt) || 0,
    history: Array.isArray(data.history) ? data.history.slice(-20) : [],
    updatedAt: Date.now(),
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('nickname')
    .setDescription('Change your server nickname (3-day cooldown)')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set your nickname')
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('New nickname (max 32 characters)')
            .setRequired(true)
            .setMaxLength(MAX_NICK),
        ),
    )
    .addSubcommand((s) =>
      s.setName('reset').setDescription('Reset your nickname to your username'),
    )
    .addSubcommand((s) =>
      s.setName('status').setDescription('Check your nickname cooldown'),
    )
    .addSubcommand((s) =>
      s
        .setName('admin-set')
        .setDescription('Set a member nickname (mods, no cooldown)')
        .addUserOption((o) =>
          o.setName('user').setDescription('Member').setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('New nickname (empty = reset)')
            .setRequired(false)
            .setMaxLength(MAX_NICK),
        ),
    ),

  category: 'utility',

  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({
        content: 'This command only works in a server.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const me = guild.members.me;

    if (!me?.permissions?.has(PermissionFlagsBits.ManageNicknames)) {
      return interaction.reply({
        content:
          'I need the **Manage Nicknames** permission (and a role above the member) to change nicknames.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // ——— status ———
    if (sub === 'status') {
      const data = await loadNickData(guild.id, interaction.user.id);
      const remaining = data.lastChangedAt + COOLDOWN_MS - Date.now();
      const onCd = remaining > 0;
      return interaction.reply({
        content: onCd
          ? `Your nickname cooldown: **${formatRemaining(remaining)}** left.\nCurrent saved nick: **${data.nickname || '(none)'}**`
          : `You can change your nickname now.\nCurrent saved nick: **${data.nickname || '(none)'}**`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ——— admin-set ———
    if (sub === 'admin-set') {
      const can =
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageNicknames) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
      if (!can) {
        return interaction.reply({
          content: 'You need **Manage Nicknames** for this.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const user = interaction.options.getUser('user', true);
      const nameOpt = interaction.options.getString('name');
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        return interaction.reply({
          content: 'Member not found in this server.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (member.id === guild.ownerId) {
        return interaction.reply({
          content: "I can't change the server owner's nickname.",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
        return interaction.reply({
          content: "My role must be **higher** than that member's highest role.",
          flags: MessageFlags.Ephemeral,
        });
      }
      const newNick = nameOpt && nameOpt.trim() ? nameOpt.trim().slice(0, MAX_NICK) : null;
      try {
        await member.setNickname(newNick, `Admin nickname by ${interaction.user.tag}`);
      } catch (e) {
        return interaction.reply({
          content: `Failed: ${e.message || e}`,
          flags: MessageFlags.Ephemeral,
        });
      }
      const data = await loadNickData(guild.id, member.id);
      data.nickname = newNick;
      data.lastChangedAt = Date.now();
      data.history.push({ nick: newNick, at: Date.now(), by: interaction.user.id });
      await saveNickData(guild.id, member.id, data);
      return interaction.reply({
        content: newNick
          ? `Set **${member.user.tag}** nickname to **${newNick}**.`
          : `Reset **${member.user.tag}** nickname.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ——— set / reset (self) ———
    const member = interaction.member;
    if (!member || typeof member.setNickname !== 'function') {
      return interaction.reply({
        content: 'Could not load your member data.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (member.id === guild.ownerId) {
      return interaction.reply({
        content:
          "Discord doesn't allow bots to change the **server owner's** nickname. Change it in Server Settings → You.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
      return interaction.reply({
        content:
          "My role must be **above yours** to change your nickname. Ask staff to move my role higher.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const data = await loadNickData(guild.id, interaction.user.id);
    const remaining = data.lastChangedAt + COOLDOWN_MS - Date.now();
    if (remaining > 0) {
      return interaction.reply({
        content: `Nickname cooldown active. Try again in **${formatRemaining(remaining)}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    let newNick = null;
    if (sub === 'set') {
      newNick = interaction.options.getString('name', true).trim().slice(0, MAX_NICK);
      if (!newNick) {
        return interaction.reply({
          content: 'Nickname cannot be empty. Use `/nickname reset` to clear it.',
          flags: MessageFlags.Ephemeral,
        });
      }
      // basic safety: block @everyone pings style
      if (/@everyone|@here|<@&?\d+>/i.test(newNick)) {
        return interaction.reply({
          content: 'That nickname contains mentions — pick another.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    try {
      await member.setNickname(newNick, 'User /nickname command');
    } catch (e) {
      return interaction.reply({
        content: `Couldn't change nickname: ${e.message || e}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    data.nickname = newNick;
    data.lastChangedAt = Date.now();
    data.history.push({ nick: newNick, at: Date.now(), by: interaction.user.id });
    await saveNickData(guild.id, interaction.user.id, data);

    return interaction.reply({
      content: newNick
        ? `Nickname set to **${newNick}**. Next change available in **3 days**.`
        : `Nickname reset. Next change available in **3 days**.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
