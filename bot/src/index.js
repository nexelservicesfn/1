require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits
} = require('discord.js');

const { DISCORD_TOKEN, GUILD_ID, ADMIN_ROLE_ID } = process.env;
if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is missing');

const db = new Database(
  process.env.DB_PATH || path.join(__dirname, '..', '..', 'server', 'data', 'nexel.db')
);
db.pragma('journal_mode = WAL');

// Safe migration for databases created before key pausing was added.
const keyColumns = db.prepare('PRAGMA table_info(keys)').all();
if (!keyColumns.some(column => column.name === 'paused')) {
  db.exec('ALTER TABLE keys ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
}
if (!keyColumns.some(column => column.name === 'deleted')) {
  db.exec('ALTER TABLE keys ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
}

const TIERS = {
  '1d':       { label: '1 Day',    ms: 86_400_000 },
  '7d':       { label: '1 Week',   ms: 604_800_000 },
  '30d':      { label: '1 Month',  ms: 2_592_000_000 },
  'lifetime': { label: 'Lifetime', ms: null }
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateKey() {
  const bytes = crypto.randomBytes(20);
  let value = '';
  for (let i = 0; i < 20; i++) value += ALPHABET[bytes[i] % 32];
  return 'NEXEL-' + value.match(/.{5}/g).join('-');
}

function normalizeKey(value) {
  return String(value || '').trim().toUpperCase();
}

function createKeys(tier, amount, createdBy) {
  if (!TIERS[tier]) throw new Error('Unknown license tier');
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO keys (key, tier, duration_ms, created_by, created_at, paused)
    VALUES (?, ?, ?, ?, ?, 0)
  `);
  const exists = db.prepare('SELECT 1 FROM keys WHERE key = ?');
  const made = [];

  const transaction = db.transaction(() => {
    for (let n = 0; n < amount; n++) {
      let key = generateKey();
      while (exists.get(key)) key = generateKey();
      insert.run(key, tier, TIERS[tier].ms, createdBy, now);
      made.push(key);
    }
  });
  transaction();
  return made;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

client.on('error', error => console.error('[bot] client error:', error.message));
process.on('unhandledRejection', error => console.error('[bot] unhandled:', error?.message || error));

function isAdmin(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  return ADMIN_ROLE_ID ? member.roles?.cache?.has(ADMIN_ROLE_ID) : false;
}

function tierOption(option) {
  return option.setName('tier').setDescription('Key duration').setRequired(true)
    .addChoices(
      { name: '1 Day', value: '1d' },
      { name: '1 Week', value: '7d' },
      { name: '1 Month', value: '30d' },
      { name: 'Lifetime', value: 'lifetime' }
    );
}

function keyOption(option) {
  return option.setName('key').setDescription('The license key').setRequired(true);
}

const commands = [
  new SlashCommandBuilder()
    .setName('gen')
    .setDescription('Generate license keys')
    .addStringOption(tierOption)
    .addIntegerOption(option => option.setName('amount').setDescription('How many (1-25)').setMinValue(1).setMaxValue(25))
    .addUserOption(option => option.setName('user').setDescription('DM the keys to this user')),

  new SlashCommandBuilder()
    .setName('key')
    .setDescription('License key commands')
    .addSubcommand(sub => sub
      .setName('generate')
      .setDescription('Generate keys and post them publicly in this channel')
      .addStringOption(tierOption)
      .addIntegerOption(option => option.setName('amount').setDescription('How many (1-25)').setMinValue(1).setMaxValue(25)))
    .addSubcommand(sub => sub
      .setName('pause')
      .setDescription('Pause a license key and sign out its active emulator session')
      .addStringOption(keyOption))
    .addSubcommand(sub => sub
      .setName('unpause')
      .setDescription('Unpause a license key')
      .addStringOption(keyOption))
    .addSubcommand(sub => sub
      .setName('delete')
      .setDescription('Permanently delete a license key and sign out its active emulator session')
      .addStringOption(keyOption)),

  new SlashCommandBuilder().setName('keys').setDescription('Show the 20 most recent active keys'),
  new SlashCommandBuilder().setName('revoke').setDescription('Revoke a key')
    .addStringOption(keyOption),
  new SlashCommandBuilder().setName('whois').setDescription('Look up a key owner')
    .addStringOption(keyOption)
].map(command => command.toJSON());

let registered = false;
async function registerCommands() {
  if (registered) return;
  if (!GUILD_ID) {
    console.error('[bot] GUILD_ID missing, skipping command registration');
    return;
  }
  registered = true;
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log(`[bot] registered ${commands.length} commands in ${GUILD_ID}`);
  } catch (error) {
    registered = false;
    console.error('[bot] command registration failed:', error.message);
  }
}

client.once('ready', () => {
  console.log(`[bot] ${client.user.tag} online`);
  registerCommands();
});

function keyStatus(row) {
  if (row.deleted) return 'DELETED';
  if (row.paused) return 'PAUSED';
  if (row.redeemed_by) return `used ${row.redeemed_by}`;
  return 'unused';
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const subcommand = interaction.commandName === 'key'
    ? interaction.options.getSubcommand(false)
    : null;
  const isPublicGenerate = interaction.commandName === 'key' && subcommand === 'generate';

  try {
    await interaction.deferReply({ ephemeral: !isPublicGenerate });

    if (!isAdmin(interaction.member)) {
      return interaction.editReply('You do not have permission to use this.');
    }

    if (interaction.commandName === 'key') {
      if (subcommand === 'generate') {
        const tier = interaction.options.getString('tier', true);
        const amount = interaction.options.getInteger('amount') || 1;
        const made = createKeys(tier, amount, interaction.user.id);
        const block = '```\n' + made.join('\n') + '\n```';
        return interaction.editReply({
          content: `**Nexel Emulator — ${TIERS[tier].label}**\nGenerated by ${interaction.user}\n${block}`,
          allowedMentions: { users: [interaction.user.id] }
        });
      }

      const key = normalizeKey(interaction.options.getString('key'));
      const row = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
      if (!row || row.deleted) return interaction.editReply('❌ Key not found. It may already have been deleted.');

      if (subcommand === 'pause') {
        if (row.revoked) return interaction.editReply('❌ This key is already revoked.');
        if (row.paused) return interaction.editReply('⏸️ This key is already paused.');
        db.prepare('UPDATE keys SET paused = 1 WHERE key = ?').run(key);
        return interaction.editReply(
          `⏸️ Paused \`${key}\`. The emulator will detect this on its next license check and return the user to the license page.`
        );
      }

      if (subcommand === 'unpause') {
        if (row.deleted) return interaction.editReply('❌ This key was deleted and cannot be unpaused.');
        if (row.revoked) return interaction.editReply('❌ This key is revoked and cannot be unpaused.');
        if (!row.paused) return interaction.editReply('This key is not paused.');
        db.prepare('UPDATE keys SET paused = 0 WHERE key = ?').run(key);
        return interaction.editReply(`✅ Unpaused \`${key}\`.`);
      }

      if (subcommand === 'delete') {
        // Soft-delete: preserve the key forever as a tombstone so it cannot
        // be re-generated/redeemed and active sessions are invalidated.
        db.prepare('UPDATE keys SET deleted = 1 WHERE key = ?').run(key);
        return interaction.editReply(
          `🗑️ Deleted \`${key}\`. The emulator will detect the deletion on its next license check and return the user to the license page.`
        );
      }
    }

    if (interaction.commandName === 'gen') {
      const tier = interaction.options.getString('tier', true);
      const amount = interaction.options.getInteger('amount') || 1;
      const target = interaction.options.getUser('user');
      const made = createKeys(tier, amount, interaction.user.id);
      const block = '```\n' + made.join('\n') + '\n```';

      if (target) {
        try {
          await target.send({
            content: `**Nexel Emulator — ${TIERS[tier].label}**\n${block}\nRedeem in the loader after logging in with Discord.`
          });
          return interaction.editReply(`Sent ${amount}x **${TIERS[tier].label}** to ${target}.`);
        } catch {
          return interaction.editReply(`Could not DM ${target}.\n${block}`);
        }
      }
      return interaction.editReply(`Generated ${amount}x **${TIERS[tier].label}**:\n${block}`);
    }

    if (interaction.commandName === 'keys') {
      const rows = db.prepare(
        'SELECT * FROM keys WHERE revoked = 0 AND deleted = 0 ORDER BY created_at DESC LIMIT 20'
      ).all();
      if (!rows.length) return interaction.editReply('No active keys yet.');
      const lines = rows.map(row =>
        `${row.key} — ${TIERS[row.tier]?.label ?? row.tier} — ${keyStatus(row)}`
      );
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle('Recent keys')
          .setDescription('```\n' + lines.join('\n') + '\n```')
          .setColor(0x2fa8ff)]
      });
    }

    if (interaction.commandName === 'revoke') {
      const key = normalizeKey(interaction.options.getString('key'));
      const row = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
      if (!row) return interaction.editReply('Unknown key.');
      db.prepare('UPDATE keys SET revoked = 1 WHERE key = ?').run(key);
      return interaction.editReply(`Revoked \`${key}\`.`);
    }

    if (interaction.commandName === 'whois') {
      const key = normalizeKey(interaction.options.getString('key'));
      const row = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
      if (!row) return interaction.editReply('Unknown key.');
      return interaction.editReply(
        `Key: \`${row.key}\`\n` +
        `Tier: ${TIERS[row.tier]?.label ?? row.tier}\n` +
        `Owner: ${row.redeemed_by ? `<@${row.redeemed_by}>` : 'unused'}\n` +
        `Created: <t:${Math.floor(row.created_at / 1000)}:R>\n` +
        `Paused: ${row.paused ? 'yes' : 'no'}\n` +
        `Revoked: ${row.revoked ? 'yes' : 'no'}`
      );
    }
  } catch (error) {
    console.error('[bot] command failed:', error);
    const message = 'The command failed. Check the bot logs.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN);
