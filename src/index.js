require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!GUILD_ID) throw new Error('Missing GUILD_ID');
if (!CLIENT_ID) throw new Error('Missing CLIENT_ID');

const HIDDEN_CATEGORY_IDS = new Set([
  '1435716621883801752',
  '1468088323531608157',
  '1478972346604851230',
  '1554376662076887040',
  '1527221909979271218',
  '1433637873524936874',
  '1527222019379433584',
  '1434635261412769861',
  '1556906426323173386',
  '1564178788370096240',
]);

const ROLE_PREFIX = 'NR |';
const STATE_FILE = path.join(__dirname, '..', 'notification-state.json');
const MAX_BUTTONS_PER_ROW = 5;
const MAX_BUTTONS_PER_MESSAGE = 25;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const defaultState = {
  channelRoles: {},
  sticky: {},
  panelChannelId: null,
  panelMessageKeys: {},
};

let state = loadState();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return {
        ...defaultState,
        ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')),
      };
    }
  } catch (err) {
    console.error('Failed to load state:', err);
  }

  return { ...defaultState };
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(state, null, 2),
      'utf8'
    );
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}

function roleNameForChannel(channel) {
  return `${ROLE_PREFIX}${channel.name}`;
}

function isNotificationRole(role) {
  return role.name.startsWith(ROLE_PREFIX);
}

function isManageMessages(member) {
  return member.permissions.has(
    PermissionsBitField.Flags.ManageMessages
  );
}

function isManageRoles(member) {
  return member.permissions.has(
    PermissionsBitField.Flags.ManageRoles
  );
}

function isEligibleChannel(channel) {
  if (!channel.parentId) return false;

  return !HIDDEN_CATEGORY_IDS.has(channel.parentId);
}

function sortChannelsInServerOrder(channels) {
  return [...channels].sort((a, b) => {
    if (a.position !== b.position) {
      return a.position - b.position;
    }

    return a.id.localeCompare(b.id);
  });
}

function getStructure(guild) {
  const categories = [...guild.channels.cache.values()]
    .filter(channel => channel.type === 4)
    .filter(category => !HIDDEN_CATEGORY_IDS.has(category.id))
    .sort((a, b) => {
      // IMPORTANT:
      // Discord category order, NOT alphabetical.
      if (a.position !== b.position) {
        return a.position - b.position;
      }

      return a.id.localeCompare(b.id);
    });

  return categories.map(category => {
    const channels = [...guild.channels.cache.values()]
      .filter(channel => channel.parentId === category.id)
      .filter(channel => channel.type === 0)
      .filter(isEligibleChannel)
      .sort((a, b) => {
        // IMPORTANT:
        // Channel order exactly follows Discord.
        if (a.position !== b.position) {
          return a.position - b.position;
        }

        return a.id.localeCompare(b.id);
      });

    return {
      category,
      channels,
    };
  });
}

function getAllServerTextChannels(guild) {
  return [...guild.channels.cache.values()]
    .filter(channel => channel.type === 0);
}

async function reconcileRoles(guild, structure, options = {}) {
  const allowCreate = options.allowCreate === true;

  const allEligibleChannels = structure.flatMap(x => x.channels);

  const existingNotificationRoles = [...guild.roles.cache.values()]
    .filter(isNotificationRole);

  const roleByExactName = new Map();

  for (const role of existingNotificationRoles) {
    if (!roleByExactName.has(role.name)) {
      roleByExactName.set(role.name, role);
    }
  }

  const usedRoleIds = new Set();

  // First preserve roles already mapped to channels.
  for (const channel of allEligibleChannels) {
    const savedRoleId = state.channelRoles[channel.id];

    if (!savedRoleId) continue;

    const role = guild.roles.cache.get(savedRoleId);

    if (!role || !isNotificationRole(role)) {
      delete state.channelRoles[channel.id];
      continue;
    }

    if (usedRoleIds.has(role.id)) {
      continue;
    }

    usedRoleIds.add(role.id);

    const wantedName = roleNameForChannel(channel);

    if (role.name !== wantedName) {
      try {
        await role.setName(wantedName, 'Notification role channel rename');
      } catch (err) {
        console.error(
          `Failed to rename role ${role.id}:`,
          err
        );
      }
    }
  }

  // Next reuse existing exact-name roles.
  for (const channel of allEligibleChannels) {
    if (state.channelRoles[channel.id]) continue;

    const wantedName = roleNameForChannel(channel);
    const role = roleByExactName.get(wantedName);

    if (!role) continue;
    if (usedRoleIds.has(role.id)) continue;

    state.channelRoles[channel.id] = role.id;
    usedRoleIds.add(role.id);
  }

  saveState();

  // Only create roles after EVERY existing NR role has been scanned.
  if (!allowCreate) {
    return;
  }

  for (const channel of allEligibleChannels) {
    if (state.channelRoles[channel.id]) continue;

    const wantedName = roleNameForChannel(channel);

    let role = roleByExactName.get(wantedName);

    if (role && !usedRoleIds.has(role.id)) {
      state.channelRoles[channel.id] = role.id;
      usedRoleIds.add(role.id);
      continue;
    }

    try {
      role = await guild.roles.create({
        name: wantedName,
        reason: 'Create notification role for channel',
      });

      state.channelRoles[channel.id] = role.id;
      usedRoleIds.add(role.id);

      roleByExactName.set(wantedName, role);
    } catch (err) {
      console.error(
        `Failed to create ${wantedName}:`,
        err
      );
    }
  }

  saveState();
}

async function cleanupDeletedChannels(guild, structure) {
  const allChannels = getAllServerTextChannels(guild);
  const allChannelIds = new Set(allChannels.map(c => c.id));

  for (const [channelId, roleId] of Object.entries(
    state.channelRoles
  )) {
    if (allChannelIds.has(channelId)) {
      continue;
    }

    const role = guild.roles.cache.get(roleId);

    if (role && isNotificationRole(role)) {
      try {
        await role.delete(
          'Channel deleted; removing notification role'
        );
      } catch (err) {
        console.error(
          `Failed to delete role ${roleId}:`,
          err
        );
      }
    }

    delete state.channelRoles[channelId];
  }

  saveState();
}

async function cleanupDuplicates(guild, structure) {
  const desiredNames = new Set(
    structure
      .flatMap(x => x.channels)
      .map(roleNameForChannel)
  );

  const grouped = new Map();

  for (const role of guild.roles.cache.values()) {
    if (!isNotificationRole(role)) continue;

    if (!grouped.has(role.name)) {
      grouped.set(role.name, []);
    }

    grouped.get(role.name).push(role);
  }

  for (const [name, roles] of grouped.entries()) {
    if (roles.length <= 1) continue;

    const mappedRoleIds = new Set(
      Object.values(state.channelRoles)
    );

    // Keep the role currently mapped to a channel if possible.
    let keeper =
      roles.find(role => mappedRoleIds.has(role.id)) ||
      roles[0];

    for (const role of roles) {
      if (role.id === keeper.id) continue;

      try {
        await role.delete(
          'Remove duplicate notification role'
        );
      } catch (err) {
        console.error(
          `Failed to delete duplicate ${role.name}:`,
          err
        );
      }
    }
  }

  // Remove unused NR roles that do not correspond to an
  // eligible channel. This NEVER creates anything.
  for (const role of guild.roles.cache.values()) {
    if (!isNotificationRole(role)) continue;

    const mapped = Object.values(state.channelRoles).includes(
      role.id
    );

    if (mapped) continue;

    if (!desiredNames.has(role.name)) {
      try {
        await role.delete(
          'Remove unused notification role'
        );
      } catch (err) {
        console.error(
          `Failed to delete unused ${role.name}:`,
          err
        );
      }
    }
  }

  saveState();
}

function makePanelPages(structure) {
  const pages = [];

  for (const item of structure) {
    const chunks = [];

    for (
      let i = 0;
      i < item.channels.length;
      i += MAX_BUTTONS_PER_MESSAGE
    ) {
      chunks.push(
        item.channels.slice(
          i,
          i + MAX_BUTTONS_PER_MESSAGE
        )
      );
    }

    if (chunks.length === 0) {
      chunks.push([]);
    }

    chunks.forEach((channels, pageIndex) => {
      pages.push({
        key: `${item.category.id}:${pageIndex}`,
        category: item.category,
        channels,
        pageIndex,
        totalPages: chunks.length,
      });
    });
  }

  return pages;
}

function buildPanelMessage(page) {
  const embed = new EmbedBuilder()
    .setTitle(page.category.name);

  if (page.totalPages > 1) {
    embed.setFooter({
      text: `Page ${page.pageIndex + 1} of ${page.totalPages}`,
    });
  }

  const rows = [];

  for (
    let i = 0;
    i < page.channels.length;
    i += MAX_BUTTONS_PER_ROW
  ) {
    const rowChannels = page.channels.slice(
      i,
      i + MAX_BUTTONS_PER_ROW
    );

    const row = new ActionRowBuilder();

    for (const channel of rowChannels) {
      const roleId = state.channelRoles[channel.id];

      const button = new ButtonBuilder()
        .setCustomId(`notify:${channel.id}`)
        .setLabel(channel.name)
        .setStyle(ButtonStyle.Secondary);

      if (!roleId) {
        button.setDisabled(true);
      }

      row.addComponents(button);
    }

    rows.push(row);
  }

  return {
    embeds: [embed],
    components: rows,
  };
}

async function render(guild, structure, targetChannel) {
  const pages = makePanelPages(structure);

  if (!state.panelChannelId) {
    state.panelChannelId = targetChannel.id;
  }

  let panelChannel = guild.channels.cache.get(
    state.panelChannelId
  );

  if (!panelChannel || panelChannel.type !== 0) {
    state.panelChannelId = targetChannel.id;
    panelChannel = targetChannel;
  }

  const existingKeys = new Set(
    pages.map(page => page.key)
  );

  // Delete old panel messages whose category/page no longer exists.
  for (const [key, messageId] of Object.entries(
    state.panelMessageKeys
  )) {
    if (existingKeys.has(key)) continue;

    try {
      const message = await panelChannel.messages.fetch(
        messageId
      );

      await message.delete();
    } catch {
      // Already deleted or inaccessible.
    }

    delete state.panelMessageKeys[key];
  }

  // Edit existing messages or create missing ones.
  for (const page of pages) {
    const payload = buildPanelMessage(page);
    const existingMessageId =
      state.panelMessageKeys[page.key];

    if (existingMessageId) {
      try {
        const message =
          await panelChannel.messages.fetch(
            existingMessageId
          );

        await message.edit(payload);
        continue;
      } catch {
        delete state.panelMessageKeys[page.key];
      }
    }

    const message = await panelChannel.send(payload);

    state.panelMessageKeys[page.key] = message.id;
  }

  saveState();
}

async function sync(guild, channelForPanel) {
  console.log('Starting full server sync...');

  // Scan the complete server structure first.
  const structure = getStructure(guild);

  // Remove roles only for channels that are actually deleted.
  await cleanupDeletedChannels(guild, structure);

  // Scan/reuse ALL existing NR roles before creating anything.
  await reconcileRoles(guild, structure, {
    allowCreate: true,
  });

  // Then render the dashboard.
  await render(guild, structure, channelForPanel);

  console.log('Full server sync complete.');
}

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
      ),
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(
    TOKEN
  );

  await rest.put(
    Routes.applicationGuildCommands(
      CLIENT_ID,
      GUILD_ID
    ),
    {
      body: commands,
    }
  );

  console.log(
    `Registered Discord commands: ${commands
      .map(command => `/${command.name}`)
      .join(', ')}`
  );
}

async function setupCommand(interaction) {
  if (
    !interaction.memberPermissions.has(
      PermissionsBitField.Flags.ManageChannels
    )
  ) {
    return interaction.reply({
      content:
        'You need Manage Channels to use /setup.',
      ephemeral: true,
    });
  }

  if (!interaction.memberPermissions.has(
    PermissionsBitField.Flags.ManageRoles
  )) {
    return interaction.reply({
      content:
        'You need Manage Roles to use /setup.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({
    ephemeral: true,
  });

  state.panelChannelId = interaction.channelId;
  saveState();

  await sync(
    interaction.guild,
    interaction.channel
  );

  await interaction.editReply(
    'Notification dashboard has been set up and synchronized.'
  );
}

async function syncCommand(interaction) {
  await interaction.deferReply({
    ephemeral: true,
  });

  await sync(
    interaction.guild,
    interaction.channel
  );

  await interaction.editReply(
    'Notification roles and dashboard synchronized.'
  );
}

async function cleanupCommand(interaction) {
  if (
    !interaction.memberPermissions.has(
      PermissionsBitField.Flags.ManageRoles
    )
  ) {
    return interaction.reply({
      content:
        'You need Manage Roles to use /cleanup.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({
    ephemeral: true,
  });

  const structure = getStructure(
    interaction.guild
  );

  await cleanupDeletedChannels(
    interaction.guild,
    structure
  );

  await cleanupDuplicates(
    interaction.guild,
    structure
  );

  await interaction.editReply(
    'Cleanup complete. No new notification roles were created.'
  );
}

async function toggleNotificationRole(
  interaction
) {
  const channelId = interaction.customId.split(':')[1];

  const roleId = state.channelRoles[channelId];

  if (!roleId) {
    return interaction.reply({
      content:
        'This channel does not have a notification role yet.',
      ephemeral: true,
    });
  }

  const role =
    interaction.guild.roles.cache.get(roleId);

  if (!role) {
    return interaction.reply({
      content:
        'The notification role could not be found.',
      ephemeral: true,
    });
  }

  const member = interaction.member;

  if (member.roles.cache.has(role.id)) {
    await member.roles.remove(
      role,
      'Notification role button'
    );

    await interaction.reply({
      content: `Removed ${role.name}.`,
      ephemeral: true,
    });
  } else {
    await member.roles.add(
      role,
      'Notification role button'
    );

    await interaction.reply({
      content: `Added ${role.name}.`,
      ephemeral: true,
    });
  }
}

async function handleStickyMessage(message) {
  if (message.author.bot) return;

  const config = state.sticky[message.channelId];

  if (!config) return;

  try {
    const oldMessage =
      await message.channel.messages.fetch(
        config.messageId
      );

    if (oldMessage) {
      await oldMessage.delete();
    }
  } catch {
    // Old sticky may already be gone.
  }

  const stickyMessage =
    await message.channel.send(
      `<@&${config.roleId}>`
    );

  state.sticky[message.channelId] = {
    roleId: config.roleId,
    messageId: stickyMessage.id,
  };

  saveState();
}

async function handleStickCommand(message) {
  if (!message.content.startsWith('!stick')) {
    return false;
  }

  if (!isManageMessages(message.member)) {
    await message.reply(
      'You need Manage Messages to configure a sticky role.'
    );
    return true;
  }

  const role = message.mentions.roles.first();

  if (!role) {
    await message.reply(
      'Usage: `!stick @role`'
    );
    return true;
  }

  if (!isNotificationRole(role)) {
    await message.reply(
      'You can only sticky notification roles created by this bot.'
    );
    return true;
  }

  const stickyMessage =
    await message.channel.send(
      `<@&${role.id}>`
    );

  state.sticky[message.channelId] = {
    roleId: role.id,
    messageId: stickyMessage.id,
  };

  saveState();

  await message.delete().catch(() => {});

  return true;
}

client.once('ready', async () => {
  console.log(
    `Logged in as ${client.user.tag}`
  );

  try {
    await registerCommands();
  } catch (err) {
    console.error(
      'Failed to register commands:',
      err
    );
  }

  const guild = client.guilds.cache.get(
    GUILD_ID
  );

  if (!guild) {
    console.error(
      'Guild not found. Check GUILD_ID and bot access.'
    );
    return;
  }

  console.log(
    `Connected to guild: ${guild.name}`
  );
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup') {
        await setupCommand(interaction);
      }

      if (interaction.commandName === 'sync') {
        await syncCommand(interaction);
      }

      if (interaction.commandName === 'cleanup') {
        await cleanupCommand(interaction);
      }

      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith('notify:')
    ) {
      await toggleNotificationRole(
        interaction
      );
    }
  } catch (err) {
    console.error(
      'Interaction error:',
      err
    );

    if (interaction.deferred) {
      await interaction.editReply(
        'Something went wrong while processing that request.'
      ).catch(() => {});
    } else if (!interaction.replied) {
      await interaction.reply({
        content:
          'Something went wrong while processing that request.',
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;

    const handled =
      await handleStickCommand(message);

    if (handled) return;

    await handleStickyMessage(message);
  } catch (err) {
    console.error(
      'Message handler error:',
      err
    );
  }
});

client.on('channelCreate', async channel => {
  if (!channel.guild) return;
  if (channel.guild.id !== GUILD_ID) return;

  try {
    await sync(
      channel.guild,
      channel.guild.channels.cache.find(
        c =>
          c.id === state.panelChannelId &&
          c.type === 0
      ) || channel.guild.systemChannel
    );
  } catch (err) {
    console.error(
      'channelCreate sync error:',
      err
    );
  }
});

client.on('channelDelete', async channel => {
  if (!channel.guild) return;
  if (channel.guild.id !== GUILD_ID) return;

  try {
    const guild = channel.guild;

    const panelChannel =
      guild.channels.cache.find(
        c =>
          c.id === state.panelChannelId &&
          c.type === 0
      ) || guild.systemChannel;

    if (panelChannel) {
      await sync(
        guild,
        panelChannel
      );
    }
  } catch (err) {
    console.error(
      'channelDelete sync error:',
      err
    );
  }
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (!newChannel.guild) return;
  if (newChannel.guild.id !== GUILD_ID) return;

  try {
    const guild = newChannel.guild;

    const panelChannel =
      guild.channels.cache.find(
        c =>
          c.id === state.panelChannelId &&
          c.type === 0
      ) || guild.systemChannel;

    if (panelChannel) {
      await sync(
        guild,
        panelChannel
      );
    }
  } catch (err) {
    console.error(
      'channelUpdate sync error:',
      err
    );
  }
});

process.on(
  'unhandledRejection',
  err => {
    console.error(
      'Unhandled rejection:',
      err
    );
  }
);

process.on(
  'uncaughtException',
  err => {
    console.error(
      'Uncaught exception:',
      err
    );
  }
);

client.login(TOKEN);
