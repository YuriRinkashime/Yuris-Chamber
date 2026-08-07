import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';

const AGENTS = [
  'Brimstone', 'Phoenix', 'Sage', 'Sova', 'Viper', 'Cypher', 'Reyna', 'Killjoy',
  'Breach', 'Omen', 'Jett', 'Raze', 'Skye', 'Yoru', 'Astra', 'KAY/O', 'Chamber',
  'Neon', 'Fade', 'Harbor', 'Gekko', 'Deadlock', 'Iso', 'Clove', 'Vyse', 'Tejo',
];

const MAPS = [
  'Bind', 'Haven', 'Split', 'Ascent', 'Icebox', 'Breeze', 'Fracture', 'Pearl',
  'Lotus', 'Sunset', 'Abyss', 'Corrode',
];

const ROLES = ['Duelist', 'Controller', 'Sentinel', 'Initiator'];

const WEAPONS = [
  'Vandal', 'Phantom', 'Operator', 'Sheriff', 'Ghost', 'Spectre', 'Judge',
  'Odin', 'Ares', 'Bulldog', 'Guardian', 'Marshal', 'Outlaw',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default {
  data: new SlashCommandBuilder()
    .setName('valorant')
    .setDescription('Valorant helpers')
    .addSubcommand((s) => s.setName('agent').setDescription('Random agent'))
    .addSubcommand((s) => s.setName('map').setDescription('Random map'))
    .addSubcommand((s) => s.setName('weapon').setDescription('Random weapon'))
    .addSubcommand((s) => s.setName('role').setDescription('Random role'))
    .addSubcommand((s) =>
      s.setName('comp').setDescription('Random 5-agent team idea'),
    ),

  category: 'fun',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'agent') {
      const agent = pick(AGENTS);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff4655)
            .setTitle('Random Agent')
            .setDescription(`**${agent}**`)
            .setFooter({ text: 'BANORANT' }),
        ],
      });
    }

    if (sub === 'map') {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff4655)
            .setTitle('Random Map')
            .setDescription(`**${pick(MAPS)}**`),
        ],
      });
    }

    if (sub === 'weapon') {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff4655)
            .setTitle('Random Weapon')
            .setDescription(`**${pick(WEAPONS)}**`),
        ],
      });
    }

    if (sub === 'role') {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff4655)
            .setTitle('Random Role')
            .setDescription(`**${pick(ROLES)}**`),
        ],
      });
    }

    if (sub === 'comp') {
      const team = [];
      const pool = [...AGENTS];
      for (let i = 0; i < 5 && pool.length; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        team.push(pool.splice(idx, 1)[0]);
      }
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xff4655)
            .setTitle('Random Comp')
            .setDescription(team.map((a, i) => `**${i + 1}.** ${a}`).join('\n'))
            .setFooter({ text: 'For fun — not ranked advice' }),
        ],
      });
    }
  },
};
