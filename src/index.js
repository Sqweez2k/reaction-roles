require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  ChannelType,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PANEL_CHANNEL_ID = process.env.PANEL_CHANNEL_ID || '';
const SYNC_INTERVAL_MS = Math.max(
  15000,
  Number(process.env.SYNC_INTERVAL_MS || 60000)
);
const ROLE_PREFIX = process.env.ROLE_PREFIX || 'NR | ';

const EXCLUDED_CATEGORY_IDS = new Set([
  '1435716621883801752',
  '1468088323531608157',
  '1478972346604851230',
  '1554376662076887040',
  '1527221909979271218',
  '1433637873524936874',
  '1527222019379433584',
  '1434635261412769861',
  '1556906426323173386',
  '1564178788370096240'
]);

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error(
    'Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID.'
  );
}

/*
========================================================
PERSISTENT STORAGE
========================================================

Railway Volume is mounted at:

/data

Railway variable:

DATA_DIR=/data

This means sticky configurations survive:
- restarts
- crashes
- redeploys
- container replacement
*/

const DATA_DIR =
  process.env.DATA_DIR || path.join(process.cwd(), 'data');

const STATE_FILE = path.join(DATA_DIR, 'state.json');

console.log(`[STORAGE] State directory: ${DATA_DIR}`);
console.log(`[STORAGE] State file: ${STATE_FILE}`);

const defaults = () => ({
  guildId: GUILD_ID,
  panelChannelId: PANEL_CHANNEL_ID || null,
  panelMessageIds: [],
  panelMessageKeys: [],
  panelHash: null,
  channelRoles: {},
  stickies: {},
  lastSyncAt: null
});

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(STATE_FILE)) {
    const s = defaults();

    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(s, null, 2)
    );

    console.log('[STORAGE] Created new persistent state file.');

    return s;
  }

  try {
    const loaded = JSON.parse(
      fs.readFileSync(STATE_FILE, 'utf8')
    );

    console.log('[STORAGE] Loaded persistent state.');

    return {
      ...defaults(),
      ...loaded
    };
  } catch (err) {
    console.error(
      '[STORAGE] Could not read state file:',
      err.message
    );

    return defaults();
  }
}

let state = loadState();

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tmp = STATE_FILE + '.tmp';

  fs.writeFileSync(
    tmp,
    JSON.stringify(state, null, 2)
  );

  fs.renameSync(tmp, STATE_FILE);
}

const cleanName = name =>
  String(name)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);

const roleName = ch =>
  ROLE_PREFIX + cleanName(ch.name);

const isNR = role =>
  !!role && role.name.startsWith(ROLE_PREFIX);

const hash = value =>
  crypto
    .createHash('sha256')
    .update(value)
    .digest('hex');

const supported = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia
]);

const alpha = (a, b) =>
  a.name.localeCompare(
    b.name,
    undefined,
    {
      sensitivity: 'base',
      numeric: true
    }
  );

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Channel,
    Partials.GuildMember
  ]
});

/*
========================================================
SLASH COMMANDS
========================================================
*/

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription(
        'Create or repair the notification dashboard in this channel.'
      ),

    new SlashCommandBuilder()
      .setName('sync')
      .setDescription(
        'Synchronize notification roles and the dashboard with the server.'
      ),

    new SlashCommandBuilder()
      .setName('cleanup')
      .setDescription(
        'Remove duplicate NR notification roles without creating new ones.'
      )
  ].map(command => command.toJSON());

  const rest = new REST({
    version: '10'
  }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      CLIENT_ID,
      GUILD_ID
    ),
    {
      body: commands
    }
  );

  console.log(
    `Registered Discord commands: ${commands
      .map(c => '/' + c.name)
      .join(', ')}`
  );
}

/*
========================================================
DISCORD HELPERS
========================================================
*/

async function getGuild() {
  return client.guilds.fetch(GUILD_ID);
}

async function getChannels(guild) {
  return [
    ...(await guild.channels.fetch()).values()
  ].filter(Boolean);
}

/*
========================================================
SERVER STRUCTURE

Uses actual Discord category order and actual
channel order.
========================================================
*/

function structureOf(all) {
  const categories = all
    .filter(
      channel =>
        channel.type === ChannelType.GuildCategory &&
        !EXCLUDED_CATEGORY_IDS.has(channel.id)
    )
    .sort(
      (a, b) =>
        a.position - b.position ||
        a.id.localeCompare(b.id)
    );

  const output = [];

  for (const category of categories) {
    const children = all
      .filter(
        channel =>
          channel.parentId === category.id &&
          supported.has(channel.type)
      )
      .sort(
        (a, b) =>
          a.position - b.position ||
          a.id.localeCompare(b.id)
      );

    if (children.length) {
      output.push({
        category,
        channels: children
      });
    }
  }

  const loose = all
    .filter(
      channel =>
        !channel.parentId &&
        supported.has(channel.type)
    )
    .sort(alpha);

  if (loose.length) {
    output.push({
      category: {
        id: 'uncategorized',
        name: 'UNCATEGORIZED'
      },
      channels: loose
    });
  }

  return output;
}

/*
========================================================
ROLE RECONCILIATION

Scans everything BEFORE creating anything.
========================================================
*/

async function reconcileRoles(
  guild,
  structure,
  { allowCreate = false } = {}
) {
  await guild.roles.fetch();

  const channels = structure.flatMap(
    group => group.channels
  );

  const assigned = new Map();
  const used = new Set();
  const byName = new Map();

  /*
  First scan EVERY existing NR role.
  */

  for (const role of guild.roles.cache.values()) {
    if (!isNR(role)) continue;

    if (!byName.has(role.name)) {
      byName.set(role.name, []);
    }

    byName.get(role.name).push(role);
  }

  /*
  Preserve saved mappings first.
  */

  for (const channel of channels) {
    const savedRoleId =
      state.channelRoles[channel.id];

    const role =
      savedRoleId
        ? guild.roles.cache.get(savedRoleId)
        : null;

    if (role && isNR(role)) {
      assigned.set(channel.id, role);
      used.add(role.id);
    }
  }

  /*
  Reuse exact-name roles before creating anything.
  */

  for (const channel of channels) {
    if (assigned.has(channel.id)) continue;

    const candidates = (
      byName.get(roleName(channel)) || []
    )
      .filter(role => !used.has(role.id))
      .sort(
        (a, b) =>
          a.position - b.position
      );

    if (candidates[0]) {
      assigned.set(
        channel.id,
        candidates[0]
      );

      used.add(candidates[0].id);
    }
  }

  /*
  Rename mapped/reused roles.
  */

  for (const channel of channels) {
    const role = assigned.get(channel.id);

    if (!role) continue;

    const wanted = roleName(channel);

    if (role.name !== wanted) {
      try {
        await role.setName(
          wanted,
          'Notification channel renamed'
        );
      } catch (err) {
        console.error(
          'Role rename:',
          err.message
        );
      }
    }

    state.channelRoles[channel.id] =
      role.id;
  }

  /*
  ONLY NOW create genuinely missing roles.
  */

  if (allowCreate) {
    for (const channel of channels) {
      if (assigned.has(channel.id)) {
        continue;
      }

      if (guild.roles.cache.size >= 250) {
        throw new Error(
          `Discord role limit reached; cannot create ${roleName(channel)}.`
        );
      }

      try {
        const role =
          await guild.roles.create({
            name: roleName(channel),
            reason:
              'Notification dashboard role'
          });

        assigned.set(
          channel.id,
          role
        );

        used.add(role.id);

        state.channelRoles[channel.id] =
          role.id;
      } catch (err) {
        console.error(
          `Role create for ${channel.name}:`,
          err.message
        );
      }
    }
  }

  saveState();

  return {
    assigned,
    usedRoleIds: used
  };
}

/*
========================================================
DELETE ROLES FOR ACTUALLY DELETED CHANNELS
========================================================
*/

async function cleanupDeletedChannels(
  guild,
  all
) {
  const liveIds =
    new Set(all.map(channel => channel.id));

  for (
    const [channelId, roleId]
    of Object.entries(state.channelRoles)
  ) {
    if (liveIds.has(channelId)) {
      continue;
    }

    const role =
      guild.roles.cache.get(roleId);

    if (role && isNR(role)) {
      await role
        .delete(
          'Notification channel deleted'
        )
        .catch(err =>
          console.error(
            'Deleted channel role cleanup:',
            err.message
          )
        );
    }

    delete state.channelRoles[channelId];
  }

  saveState();
}

/*
========================================================
DUPLICATE CLEANUP

Never creates roles.
========================================================
*/

async function cleanupDuplicates(
  guild,
  all
) {
  const structure =
    structureOf(all);

  await reconcileRoles(
    guild,
    structure,
    {
      allowCreate: false
    }
  );

  const desired =
    new Set(
      structure
        .flatMap(group => group.channels)
        .map(roleName)
    );

  const keep =
    new Set(
      Object.values(state.channelRoles)
    );

  const duplicates = [];

  for (const role of guild.roles.cache.values()) {
    if (
      isNR(role) &&
      desired.has(role.name) &&
      !keep.has(role.id)
    ) {
      duplicates.push(role);
    }
  }

  for (const role of duplicates) {
    await role
      .delete(
        'Remove duplicate notification role'
      )
      .catch(err =>
        console.error(
          'Duplicate role delete:',
          err.message
        )
      );
  }

  saveState();

  return duplicates.length;
}

/*
========================================================
DASHBOARD
========================================================
*/

function render(structure) {
  const messages = [];

  for (const group of structure) {
    for (
      let offset = 0;
      offset < group.channels.length;
      offset += 25
    ) {
      const page =
        group.channels.slice(
          offset,
          offset + 25
        );

      const pageNo =
        Math.floor(offset / 25) + 1;

      const total =
        Math.ceil(
          group.channels.length / 25
        );

      const key =
        `${group.category.id}:${pageNo}`;

      const rows = [];

      for (
        let i = 0;
        i < page.length;
        i += 5
      ) {
        const row =
          new ActionRowBuilder();

        for (
          const channel of page.slice(
            i,
            i + 5
          )
        ) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(
                'notify:' + channel.id
              )
              .setLabel(
                cleanName(
                  channel.name
                ).slice(0, 80)
              )
              .setStyle(
                ButtonStyle.Secondary
              )
          );
        }

        rows.push(row);
      }

      messages.push({
        key,

        embeds: [
          new EmbedBuilder()
            .setTitle(
              group.category.name
            )
            .setDescription(
              total > 1
                ? `Page ${pageNo} of ${total} — click a channel to toggle its notifications.`
                : 'Click a channel to toggle its notifications.'
            )
        ],

        components: rows,

        signature:
          key +
          '||' +
          page
            .map(
              channel =>
                `${channel.id}:${channel.name}:${state.channelRoles[channel.id] || ''}`
            )
            .join('|')
      });
    }
  }

  return messages;
}

/*
========================================================
SYNC
========================================================
*/

async function sync({
  forcePanel = false
} = {}) {
  const guild =
    await getGuild();

  await guild.roles.fetch();

  const all =
    await getChannels(guild);

  const structure =
    structureOf(all);

  await cleanupDeletedChannels(
    guild,
    all
  );

  let warning = null;

  try {
    await reconcileRoles(
      guild,
      structure,
      {
        allowCreate: true
      }
    );
  } catch (err) {
    warning = err.message;

    console.error(
      'Role reconciliation:',
      err.message
    );
  }

  state.lastSyncAt =
    new Date().toISOString();

  saveState();

  const panelId =
    state.panelChannelId ||
    PANEL_CHANNEL_ID;

  if (!panelId) {
    return {
      structure,
      warning,
      updated: false
    };
  }

  const panel =
    await guild.channels
      .fetch(panelId)
      .catch(() => null);

  if (!panel?.isTextBased()) {
    return {
      structure,
      warning,
      updated: false
    };
  }

  const rendered =
    render(structure);

  const panelHash =
    hash(
      JSON.stringify(
        rendered.map(
          item => item.signature
        )
      )
    );

  if (
    !forcePanel &&
    state.panelHash === panelHash &&
    state.panelMessageIds.length ===
      rendered.length
  ) {
    return {
      structure,
      warning,
      updated: false
    };
  }

  const oldIds =
    [...state.panelMessageIds];

  const oldKeys =
    [...state.panelMessageKeys];

  const oldByKey =
    new Map(
      oldKeys
        .map(
          (key, index) => [
            key,
            oldIds[index]
          ]
        )
        .filter(
          item =>
            item[0] &&
            item[1]
        )
    );

  const ids = [];
  const keys = [];

  for (const item of rendered) {
    let message =
      oldByKey.has(item.key)
        ? await panel.messages
            .fetch(
              oldByKey.get(item.key)
            )
            .catch(() => null)
        : null;

    const payload = {
      embeds: item.embeds,
      components: item.components
    };

    if (message) {
      await message.edit(payload);
    } else {
      message =
        await panel.send(payload);
    }

    ids.push(message.id);
    keys.push(item.key);
  }

  const kept =
    new Set(ids);

  for (const id of oldIds) {
    if (kept.has(id)) continue;

    const message =
      await panel.messages
        .fetch(id)
        .catch(() => null);

    if (message) {
      await message
        .delete()
        .catch(() => {});
    }
  }

  state.panelMessageIds = ids;
  state.panelMessageKeys = keys;
  state.panelHash = panelHash;

  saveState();

  return {
    structure,
    warning,
    updated: true
  };
}

/*
========================================================
/SETUP
========================================================
*/

async function setupCommand(interaction) {
  if (
    !interaction.inGuild() ||
    interaction.guildId !== GUILD_ID
  ) {
    return interaction.reply({
      content: 'Wrong server.',
      ephemeral: true
    });
  }

  const me =
    await interaction.guild.members.fetchMe();

  if (
    !me.permissions.has(
      PermissionFlagsBits.ManageRoles
    )
  ) {
    return interaction.reply({
      content: 'I need Manage Roles.',
      ephemeral: true
    });
  }

  state.panelChannelId =
    interaction.channelId;

  saveState();

  await interaction.deferReply({
    ephemeral: true
  });

  try {
    const result =
      await sync({
        forcePanel: true
      });

    const count =
      result.structure.reduce(
        (sum, group) =>
          sum + group.channels.length,
        0
      );

    await interaction.editReply(
      result.warning
        ? `Dashboard synced for ${count} channels, but role creation hit a limit: ${result.warning}`
        : `Dashboard ready — ${count} channels synced.`
    );
  } catch (err) {
    console.error(err);

    await interaction.editReply(
      'Setup failed: ' +
        err.message
    );
  }
}

/*
========================================================
/SYNC
========================================================
*/

async function syncCommand(interaction) {
  await interaction.deferReply({
    ephemeral: true
  });

  try {
    const result =
      await sync();

    const count =
      result.structure.reduce(
        (sum, group) =>
          sum + group.channels.length,
        0
      );

    await interaction.editReply(
      `Sync complete — ${count} channels checked. Panel changed: ${
        result.updated
          ? 'yes'
          : 'no'
      }.` +
      (
        result.warning
          ? `\nWarning: ${result.warning}`
          : ''
      )
    );
  } catch (err) {
    console.error(err);

    await interaction.editReply(
      'Sync failed: ' +
        err.message
    );
  }
}

/*
========================================================
/CLEANUP
========================================================
*/

async function cleanupCommand(interaction) {
  if (
    !interaction.inGuild() ||
    interaction.guildId !== GUILD_ID
  ) {
    return interaction.reply({
      content: 'Wrong server.',
      ephemeral: true
    });
  }

  const member =
    await interaction.guild.members.fetch(
      interaction.user.id
    );

  if (
    !member.permissions.has(
      PermissionFlagsBits.ManageRoles
    )
  ) {
    return interaction.reply({
      content:
        'You need Manage Roles to run cleanup.',
      ephemeral: true
    });
  }

  await interaction.deferReply({
    ephemeral: true
  });

  try {
    const guild =
      await getGuild();

    const all =
      await getChannels(guild);

    await cleanupDeletedChannels(
      guild,
      all
    );

    const count =
      await cleanupDuplicates(
        guild,
        all
      );

    await interaction.editReply(
      `Cleanup complete — removed ${count} duplicate NR role${
        count === 1
          ? ''
          : 's'
      }. No new roles were created.`
    );
  } catch (err) {
    console.error(err);

    await interaction.editReply(
      'Cleanup failed: ' +
        err.message
    );
  }
}

/*
========================================================
BUTTON TOGGLE
========================================================
*/

async function toggle(interaction) {
  const channelId =
    interaction.customId.slice(7);

  const guild =
    interaction.guild;

  const channel =
    guild.channels.cache.get(channelId) ||
    await guild.channels
      .fetch(channelId)
      .catch(() => null);

  if (
    !channel ||
    !supported.has(channel.type) ||
    !channel.parentId ||
    EXCLUDED_CATEGORY_IDS.has(
      channel.parentId
    )
  ) {
    return interaction.reply({
      content:
        'That channel is not available for notifications.',
      ephemeral: true
    });
  }

  let role =
    state.channelRoles[channelId]
      ? guild.roles.cache.get(
          state.channelRoles[channelId]
        )
      : null;

  if (!role) {
    try {
      const result =
        await reconcileRoles(
          guild,
          structureOf(
            await getChannels(guild)
          ),
          {
            allowCreate: true
          }
        );

      role =
        result.assigned.get(
          channelId
        ) || null;
    } catch (err) {
      console.error(
        'Toggle reconciliation:',
        err.message
      );
    }
  }

  if (!role) {
    return interaction.reply({
      content:
        'I could not create/find that notification role.',
      ephemeral: true
    });
  }

  try {
    if (
      interaction.member.roles.cache.has(
        role.id
      )
    ) {
      await interaction.member.roles.remove(
        role
      );

      await interaction.reply({
        content:
          `Notifications off for #${channel.name}.`,
        ephemeral: true
      });
    } else {
      await interaction.member.roles.add(
        role
      );

      await interaction.reply({
        content:
          `Notifications on for #${channel.name}.`,
        ephemeral: true
      });
    }
  } catch (err) {
    console.error(err);

    await interaction.reply({
      content:
        'Could not change the role. Make sure my bot role is above the NR roles.',
      ephemeral: true
    });
  }
}

/*
========================================================
STICKY ROLES
========================================================
*/

function managedRoleIds() {
  return new Set(
    Object.values(
      state.channelRoles
    )
  );
}

function isManagedRole(role) {
  return (
    !!role &&
    managedRoleIds().has(role.id)
  );
}

/*
Send/re-send sticky role.

Important:
- The bot's own sticky message is ignored.
- Webhook messages ARE allowed.
- Other bots' messages ARE allowed.
*/

async function sendSticky(
  channel,
  roleId
) {
  const role =
    channel.guild.roles.cache.get(
      roleId
    );

  if (
    !role ||
    !isManagedRole(role)
  ) {
    delete state.stickies[channel.id];
    delete state.stickies[
      channel.id + '_message'
    ];

    saveState();

    return null;
  }

  const oldMessageId =
    state.stickies[
      channel.id + '_message'
    ];

  if (oldMessageId) {
    const oldMessage =
      await channel.messages
        .fetch(oldMessageId)
        .catch(() => null);

    if (oldMessage) {
      await oldMessage
        .delete()
        .catch(() => {});
    }
  }

  const newMessage =
    await channel.send({
      content: role.toString(),

      allowedMentions: {
        roles: [role.id]
      }
    });

  state.stickies[
    channel.id + '_message'
  ] = newMessage.id;

  saveState();

  console.log(
    `[STICKY] Reposted ${role.name} in #${channel.name}`
  );

  return newMessage;
}

/*
========================================================
!STICK
========================================================
*/

async function handleStickyCommand(message) {
  if (
    !message.inGuild() ||
    message.guild.id !== GUILD_ID
  ) {
    return false;
  }

  if (
    !/^!stick(?:\s|$)/i.test(
      message.content
    )
  ) {
    return false;
  }

  if (
    !message.member.permissions.has(
      PermissionFlagsBits.ManageMessages
    )
  ) {
    await message.reply(
      'You need Manage Messages to configure sticky roles.'
    );

    return true;
  }

  const role =
    message.mentions.roles.first();

  if (!role) {
    await message.reply(
      'Use `!stick @role`.'
    );

    return true;
  }

  if (!isManagedRole(role)) {
    await message.reply(
      'You can only stick notification roles created by this bot (`NR | ...`).'
    );

    return true;
  }

  /*
  Save BEFORE sending so the configuration
  itself is persistent immediately.
  */

  state.stickies[
    message.channel.id
  ] = role.id;

  saveState();

  await sendSticky(
    message.channel,
    role.id
  );

  console.log(
    `[STICKY] Saved sticky for channel ${message.channel.id} -> role ${role.id}`
  );

  return true;
}

/*
========================================================
MESSAGE HANDLER

THIS IS IMPORTANT:

We do NOT use:

if (message.author.bot) return;

because that would ignore webhook/bot posts.

We ONLY ignore this bot's own messages.
========================================================
*/

client.on(
  'messageCreate',
  async message => {
    try {
      /*
      Ignore ONLY our own bot messages.
      */

      if (
        client.user &&
        message.author.id ===
          client.user.id
      ) {
        return;
      }

      /*
      Handle !stick first.
      */

      if (
        await handleStickyCommand(
          message
        )
      ) {
        return;
      }

      if (
        !message.inGuild() ||
        message.guild.id !== GUILD_ID
      ) {
        return;
      }

      const roleId =
        state.stickies[
          message.channel.id
        ];

      if (!roleId) {
        return;
      }

      console.log(
        `[STICKY] Message detected in ${message.channel.id}` +
        (
          message.webhookId
            ? ` from webhook ${message.webhookId}`
            : ` from ${message.author.tag}`
        )
      );

      await sendSticky(
        message.channel,
        roleId
      );
    } catch (err) {
      console.error(
        '[STICKY] Error:',
        err
      );
    }
  }
);

/*
========================================================
READY
========================================================
*/

client.once(
  'ready',
  async () => {
    console.log(
      `Logged in as ${client.user.tag}`
    );

    try {
      await registerCommands();
      await sync();
    } catch (err) {
      console.error(
        'Startup:',
        err
      );
    }

    setInterval(
      () =>
        sync().catch(err =>
          console.error(
            'Periodic sync:',
            err
          )
        ),
      SYNC_INTERVAL_MS
    );
  }
);

/*
========================================================
INTERACTIONS
========================================================
*/

client.on(
  'interactionCreate',
  async interaction => {
    try {
      if (
        interaction.isChatInputCommand()
      ) {
        if (
          interaction.commandName ===
          'setup'
        ) {
          return setupCommand(
            interaction
          );
        }

        if (
          interaction.commandName ===
          'sync'
        ) {
          return syncCommand(
            interaction
          );
        }

        if (
          interaction.commandName ===
          'cleanup'
        ) {
          return cleanupCommand(
            interaction
          );
        }
      }

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'notify:'
        )
      ) {
        return toggle(
          interaction
        );
      }
    } catch (err) {
      console.error(
        'Interaction:',
        err
      );

      if (
        !interaction.replied &&
        !interaction.deferred
      ) {
        await interaction
          .reply({
            content:
              'Something went wrong.',
            ephemeral: true
          })
          .catch(() => {});
      }
    }
  }
);

/*
========================================================
AUTO SYNC WHEN CHANNELS CHANGE
========================================================
*/

for (
  const event of [
    'channelCreate',
    'channelDelete',
    'channelUpdate'
  ]
) {
  client.on(
    event,
    async channel => {
      if (
        channel.guild?.id !==
        GUILD_ID
      ) {
        return;
      }

      try {
        await sync();
      } catch (err) {
        console.error(
          event,
          err
        );
      }
    }
  );
}

/*
========================================================
ERROR HANDLERS
========================================================
*/

process.on(
  'unhandledRejection',
  error =>
    console.error(
      'Unhandled rejection:',
      error
    )
);

process.on(
  'uncaughtException',
  error =>
    console.error(
      'Uncaught exception:',
      error
    )
);

/*
========================================================
LOGIN
========================================================
*/

client.login(TOKEN);
