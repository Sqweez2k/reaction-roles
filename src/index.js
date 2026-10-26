require('dotenv').config();
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {
  Client,GatewayIntentBits,Partials,PermissionFlagsBits,ChannelType,
  SlashCommandBuilder,REST,Routes,ActionRowBuilder,ButtonBuilder,
  ButtonStyle,EmbedBuilder
}=require('discord.js');

const TOKEN=process.env.DISCORD_TOKEN;
const CLIENT_ID=process.env.CLIENT_ID;
const GUILD_ID=process.env.GUILD_ID;
const PANEL_CHANNEL_ID=process.env.PANEL_CHANNEL_ID||'';
const SYNC_INTERVAL_MS=Math.max(15000,Number(process.env.SYNC_INTERVAL_MS||60000));
const ROLE_PREFIX=process.env.ROLE_PREFIX||'NR | ';

const EXCLUDED_CATEGORY_IDS=new Set([
  '1435716621883801752',
  '1468088323531608157',
  '1478972346604851230',
  '1554376662076887040',
  '1527221909979271218',
  '1433637873524936874',
  '1527222019379433584',
  '1434635261412769861',
  '1556906426323173386'
]);

if(!TOKEN||!CLIENT_ID||!GUILD_ID){
  throw new Error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID.');
}

const DATA_DIR=path.join(process.cwd(),'data');
const STATE_FILE=path.join(DATA_DIR,'state.json');

const defaults=()=>({
  guildId:GUILD_ID,
  panelChannelId:PANEL_CHANNEL_ID||null,
  panelMessageIds:[],
  panelMessageKeys:[],
  panelHash:null,
  channelRoles:{},
  stickies:{},
  lastSyncAt:null
});

function loadState(){
  fs.mkdirSync(DATA_DIR,{recursive:true});

  if(!fs.existsSync(STATE_FILE)){
    const s=defaults();
    fs.writeFileSync(STATE_FILE,JSON.stringify(s,null,2));
    return s;
  }

  try{
    return {
      ...defaults(),
      ...JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))
    };
  }catch{
    return defaults();
  }
}

let state=loadState();

function saveState(){
  fs.mkdirSync(DATA_DIR,{recursive:true});

  const tmp=STATE_FILE+'.tmp';

  fs.writeFileSync(
    tmp,
    JSON.stringify(state,null,2)
  );

  fs.renameSync(tmp,STATE_FILE);
}

const cleanName=n=>
  String(n)
    .replace(/[\r\n]+/g,' ')
    .replace(/\s+/g,' ')
    .trim()
    .slice(0,90);

const roleName=ch=>
  ROLE_PREFIX+cleanName(ch.name);

const isNR=r=>
  !!r&&r.name.startsWith(ROLE_PREFIX);

const hash=v=>
  crypto
    .createHash('sha256')
    .update(v)
    .digest('hex');

const supported=new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia
]);

const alpha=(a,b)=>
  a.name.localeCompare(
    b.name,
    undefined,
    {
      sensitivity:'base',
      numeric:true
    }
  );

const client=new Client({
  intents:[
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials:[
    Partials.Channel,
    Partials.GuildMember
  ]
});


/*
====================================================
DISCORD SLASH COMMAND REGISTRATION
====================================================

These are GUILD commands.

They will appear in Discord's normal "/" command
menu for the configured GUILD_ID.

Commands:
  /setup
  /sync
  /cleanup
====================================================
*/

async function registerCommands(){

  const commands=[

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

  ].map(c=>c.toJSON());

  const rest=
    new REST({
      version:'10'
    }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      CLIENT_ID,
      GUILD_ID
    ),
    {
      body:commands
    }
  );

  console.log(
    `Registered Discord commands: ${
      commands.map(c=>'/'+c.name).join(', ')
    }`
  );
}


async function getGuild(){
  return client.guilds.fetch(GUILD_ID);
}


async function getChannels(guild){
  return [
    ...(await guild.channels.fetch()).values()
  ].filter(Boolean);
}


/*
====================================================
BUILD SERVER STRUCTURE
====================================================
*/

function structureOf(all){

  const cats=all
    .filter(
      c=>
        c.type===ChannelType.GuildCategory &&
        !EXCLUDED_CATEGORY_IDS.has(c.id)
    )
    .sort(alpha);

  const out=[];

  for(const cat of cats){

    const children=all
      .filter(
        c=>
          c.parentId===cat.id &&
          supported.has(c.type)
      )
      .sort(alpha);

    if(children.length){

      out.push({
        category:cat,
        channels:children
      });

    }
  }

  const loose=all
    .filter(
      c=>
        !c.parentId &&
        supported.has(c.type)
    )
    .sort(alpha);

  if(loose.length){

    out.push({
      category:{
        id:'uncategorized',
        name:'UNCATEGORIZED'
      },
      channels:loose
    });

  }

  return out;
}


function managedRoleIds(){
  return new Set(
    Object.values(state.channelRoles)
  );
}


/*
====================================================
FULL ROLE RECONCILIATION

IMPORTANT:

1. Scan every eligible channel.
2. Scan every existing NR role.
3. Reuse saved mappings.
4. Reuse existing exact-name NR roles.
5. ONLY THEN create genuinely missing roles.

This prevents the duplicate-role problem.
====================================================
*/

async function reconcileRoles(
  guild,
  structure,
  {allowCreate=false}={}
){

  await guild.roles.fetch();

  const list=
    structure.flatMap(
      g=>g.channels
    );

  const assigned=new Map();
  const used=new Set();
  const byName=new Map();


  /*
  FIRST:
  Scan ALL existing NR roles.
  */

  for(
    const r of guild.roles.cache.values()
  ){

    if(!isNR(r)) continue;

    if(!byName.has(r.name)){
      byName.set(r.name,[]);
    }

    byName
      .get(r.name)
      .push(r);
  }


  /*
  SECOND:
  Preserve saved channel -> role mappings.
  */

  for(const ch of list){

    const mappedId=
      state.channelRoles[ch.id];

    const r=
      mappedId
        ? guild.roles.cache.get(mappedId)
        : null;

    if(
      r &&
      isNR(r)
    ){

      assigned.set(
        ch.id,
        r
      );

      used.add(r.id);
    }
  }


  /*
  THIRD:
  Reuse existing exact-name NR roles.

  NO CREATION YET.
  */

  for(const ch of list){

    if(assigned.has(ch.id)){
      continue;
    }

    const candidates=
      (
        byName.get(
          roleName(ch)
        )||[]
      )
      .filter(
        r=>!used.has(r.id)
      )
      .sort(
        (a,b)=>a.position-b.position
      );

    if(candidates[0]){

      assigned.set(
        ch.id,
        candidates[0]
      );

      used.add(
        candidates[0].id
      );
    }
  }


  /*
  FOURTH:
  Rename mapped/reused roles if the channel
  itself was renamed.
  */

  for(const ch of list){

    const r=
      assigned.get(ch.id);

    if(!r){
      continue;
    }

    const wanted=
      roleName(ch);

    if(r.name!==wanted){

      try{

        await r.setName(
          wanted,
          'Notification channel renamed'
        );

      }catch(e){

        console.error(
          'Role rename:',
          e.message
        );

      }
    }

    state.channelRoles[ch.id]=r.id;
  }


  /*
  FIFTH:
  ONLY NOW create missing roles.
  */

  if(allowCreate){

    for(const ch of list){

      if(assigned.has(ch.id)){
        continue;
      }

      if(guild.roles.cache.size>=250){

        throw new Error(
          `Discord role limit reached; cannot create ${roleName(ch)}.`
        );

      }

      try{

        const r=
          await guild.roles.create({
            name:roleName(ch),
            reason:'Notification dashboard role'
          });

        assigned.set(
          ch.id,
          r
        );

        used.add(
          r.id
        );

        state.channelRoles[ch.id]=r.id;

      }catch(e){

        console.error(
          `Role create for ${ch.name}:`,
          e.message
        );

      }
    }
  }

  saveState();

  return {
    assigned,
    usedRoleIds:used
  };
}


/*
====================================================
DELETE ROLES FOR ACTUALLY DELETED CHANNELS

A channel moved into an excluded category is NOT
deleted, so its existing role stays untouched.
====================================================
*/

async function cleanupDeletedChannels(
  guild,
  all
){

  const liveIds=
    new Set(
      all.map(c=>c.id)
    );

  for(
    const [cid,rid]
    of Object.entries(
      state.channelRoles
    )
  ){

    if(liveIds.has(cid)){
      continue;
    }

    const r=
      guild.roles.cache.get(rid);

    if(
      r &&
      isNR(r)
    ){

      await r
        .delete(
          'Notification channel deleted'
        )
        .catch(
          e=>
            console.error(
              'Deleted channel role cleanup:',
              e.message
            )
        );
    }

    delete state.channelRoles[cid];
  }

  saveState();
}


/*
====================================================
/cleanup

NEVER creates roles.

Only removes duplicate NR roles belonging to
currently eligible dashboard channel names.
====================================================
*/

async function cleanupDuplicates(
  guild,
  all
){

  const structure=
    structureOf(all);

  await reconcileRoles(
    guild,
    structure,
    {
      allowCreate:false
    }
  );

  const desired=
    new Set(
      structure
        .flatMap(g=>g.channels)
        .map(roleName)
    );

  const keep=
    new Set(
      Object.values(
        state.channelRoles
      )
    );

  const duplicates=[];

  for(
    const r of guild.roles.cache.values()
  ){

    if(
      isNR(r) &&
      desired.has(r.name) &&
      !keep.has(r.id)
    ){

      duplicates.push(r);
    }
  }

  for(
    const r of duplicates
  ){

    await r
      .delete(
        'Remove duplicate notification role'
      )
      .catch(
        e=>
          console.error(
            'Duplicate role delete:',
            e.message
          )
      );
  }

  saveState();

  return duplicates.length;
}


/*
====================================================
PANEL RENDERING

ONE CATEGORY PER DISCORD MESSAGE.

If a category has >25 channels, only that category
is split into multiple messages.

Never mix two categories together.
====================================================
*/

function render(structure){

  const messages=[];

  for(
    const group of structure
  ){

    for(
      let offset=0;
      offset<group.channels.length;
      offset+=25
    ){

      const page=
        group.channels.slice(
          offset,
          offset+25
        );

      const pageNo=
        Math.floor(offset/25)+1;

      const total=
        Math.ceil(
          group.channels.length/25
        );

      const key=
        `${group.category.id}:${pageNo}`;

      const rows=[];

      for(
        let i=0;
        i<page.length;
        i+=5
      ){

        const row=
          new ActionRowBuilder();

        for(
          const ch
          of page.slice(i,i+5)
        ){

          row.addComponents(

            new ButtonBuilder()

              .setCustomId(
                'notify:'+ch.id
              )

              .setLabel(
                cleanName(ch.name).slice(0,80)
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

        embeds:[

          new EmbedBuilder()

            .setTitle(
              group.category.name
            )

            .setDescription(
              total>1

                ? `Page ${pageNo} of ${total} — click a channel to toggle its notifications.`

                : 'Click a channel to toggle its notifications.'
            )

        ],

        components:rows,

        signature:
          key+
          '||'+
          page
            .map(
              ch=>
                `${ch.id}:${ch.name}:${state.channelRoles[ch.id]||''}`
            )
            .join('|')

      });
    }
  }

  return messages;
}


/*
====================================================
SYNC

Scans everything first, then reconciles roles,
then updates the dashboard.
====================================================
*/

async function sync(
  {forcePanel=false}={}
){

  const guild=
    await getGuild();

  await guild.roles.fetch();

  const all=
    await getChannels(guild);

  const structure=
    structureOf(all);


  /*
  Remove roles only for channels that truly
  disappeared from the guild.
  */

  await cleanupDeletedChannels(
    guild,
    all
  );


  /*
  FULL SERVER ROLE SCAN BEFORE CREATION.
  */

  let warning=null;

  try{

    await reconcileRoles(
      guild,
      structure,
      {
        allowCreate:true
      }
    );

  }catch(e){

    warning=e.message;

    console.error(
      'Role reconciliation:',
      e.message
    );
  }


  state.lastSyncAt=
    new Date().toISOString();

  saveState();


  const panelId=
    state.panelChannelId ||
    PANEL_CHANNEL_ID;

  if(!panelId){

    return {
      structure,
      warning,
      updated:false
    };
  }


  const panel=
    await guild.channels
      .fetch(panelId)
      .catch(()=>null);

  if(
    !panel ||
    !panel.isTextBased()
  ){

    return {
      structure,
      warning,
      updated:false
    };
  }


  const rendered=
    render(structure);

  const panelHash=
    hash(
      JSON.stringify(
        rendered.map(
          x=>x.signature
        )
      )
    );


  if(
    !forcePanel &&
    state.panelHash===panelHash &&
    state.panelMessageIds.length===
      rendered.length
  ){

    return {
      structure,
      warning,
      updated:false
    };
  }


  /*
  Match old messages by CATEGORY/PAGE KEY,
  not by array position.

  This prevents category messages from getting
  swapped around when the server changes.
  */

  const oldIds=
    [...state.panelMessageIds];

  const oldKeys=
    [...state.panelMessageKeys];

  const oldByKey=
    new Map(
      oldKeys
        .map(
          (k,i)=>
            [k,oldIds[i]]
        )
        .filter(
          x=>x[0]&&x[1]
        )
    );

  const ids=[];
  const keys=[];


  for(
    const item of rendered
  ){

    let msg=
      oldByKey.has(item.key)

        ? await panel.messages
            .fetch(
              oldByKey.get(item.key)
            )
            .catch(()=>null)

        : null;


    const payload={
      embeds:item.embeds,
      components:item.components
    };


    if(msg){

      await msg.edit(
        payload
      );

    }else{

      msg=
        await panel.send(
          payload
        );
    }


    ids.push(msg.id);
    keys.push(item.key);
  }


  /*
  Delete old dashboard messages that no longer
  belong to the current structure.
  */

  const kept=
    new Set(ids);

  for(
    const id of oldIds
  ){

    if(kept.has(id)){
      continue;
    }

    const msg=
      await panel.messages
        .fetch(id)
        .catch(()=>null);

    if(msg){

      await msg
        .delete()
        .catch(()=>{});

    }
  }


  state.panelMessageIds=ids;
  state.panelMessageKeys=keys;
  state.panelHash=panelHash;

  saveState();


  return {
    structure,
    warning,
    updated:true
  };
}


/*
====================================================
/setup
====================================================
*/

async function setupCommand(i){

  if(
    !i.inGuild() ||
    i.guildId!==GUILD_ID
  ){

    return i.reply({
      content:'Wrong server.',
      ephemeral:true
    });
  }


  const me=
    await i.guild.members.fetchMe();


  if(
    !me.permissions.has(
      PermissionFlagsBits.ManageRoles
    )
  ){

    return i.reply({
      content:'I need Manage Roles.',
      ephemeral:true
    });
  }


  state.panelChannelId=
    i.channelId;

  saveState();


  await i.deferReply({
    ephemeral:true
  });


  try{

    const r=
      await sync({
        forcePanel:true
      });

    const n=
      r.structure.reduce(
        (sum,g)=>
          sum+g.channels.length,
        0
      );


    await i.editReply(

      r.warning

        ? `Dashboard synced for ${n} channels, but role creation hit a limit: ${r.warning}`

        : `Dashboard ready — ${n} channels synced.`

    );

  }catch(e){

    console.error(e);

    await i.editReply(
      'Setup failed: '+e.message
    );
  }
}


/*
====================================================
/sync
====================================================
*/

async function syncCommand(i){

  await i.deferReply({
    ephemeral:true
  });

  try{

    const r=
      await sync();

    const n=
      r.structure.reduce(
        (sum,g)=>
          sum+g.channels.length,
        0
      );


    await i.editReply(

      `Sync complete — ${n} channels checked. Panel changed: ${r.updated?'yes':'no'}.`+

      (
        r.warning
          ? `\nWarning: ${r.warning}`
          : ''
      )

    );

  }catch(e){

    console.error(e);

    await i.editReply(
      'Sync failed: '+e.message
    );
  }
}


/*
====================================================
/cleanup
====================================================

Requires Manage Roles.

Does NOT create roles.
====================================================
*/

async function cleanupCommand(i){

  if(
    !i.inGuild() ||
    i.guildId!==GUILD_ID
  ){

    return i.reply({
      content:'Wrong server.',
      ephemeral:true
    });
  }


  const member=
    await i.guild.members.fetch(
      i.user.id
    );


  if(
    !member.permissions.has(
      PermissionFlagsBits.ManageRoles
    )
  ){

    return i.reply({
      content:
        'You need Manage Roles to run cleanup.',
      ephemeral:true
    });
  }


  await i.deferReply({
    ephemeral:true
  });


  try{

    const guild=
      await getGuild();

    const all=
      await getChannels(guild);


    await cleanupDeletedChannels(
      guild,
      all
    );


    const count=
      await cleanupDuplicates(
        guild,
        all
      );


    await i.editReply(

      `Cleanup complete — removed ${count} duplicate NR role${count===1?'':'s'}. No new roles were created.`

    );

  }catch(e){

    console.error(e);

    await i.editReply(
      'Cleanup failed: '+e.message
    );
  }
}


/*
====================================================
BUTTON TOGGLE
====================================================
*/

async function toggle(i){

  const cid=
    i.customId.slice(7);

  const guild=
    i.guild;


  const ch=
    guild.channels.cache.get(cid) ||

    await guild.channels
      .fetch(cid)
      .catch(()=>null);


  if(
    !ch ||
    !supported.has(ch.type) ||
    !ch.parentId ||
    EXCLUDED_CATEGORY_IDS.has(
      ch.parentId
    )
  ){

    return i.reply({
      content:
        'That channel is not available for notifications.',
      ephemeral:true
    });
  }


  let r=
    state.channelRoles[cid]
      ? guild.roles.cache.get(
          state.channelRoles[cid]
        )
      : null;


  /*
  If the saved mapping isn't available,
  perform a complete reconciliation instead
  of blindly creating one role.
  */

  if(!r){

    try{

      const result=
        await reconcileRoles(
          guild,
          structureOf(
            await getChannels(guild)
          ),
          {
            allowCreate:true
          }
        );

      r=
        result.assigned.get(cid) ||
        null;

    }catch(e){

      console.error(
        'Toggle reconciliation:',
        e.message
      );
    }
  }


  if(!r){

    return i.reply({
      content:
        'I could not create/find that notification role.',
      ephemeral:true
    });
  }


  try{

    if(
      i.member.roles.cache.has(
        r.id
      )
    ){

      await i.member.roles.remove(
        r
      );

      await i.reply({
        content:
          `Notifications off for #${ch.name}.`,
        ephemeral:true
      });

    }else{

      await i.member.roles.add(
        r
      );

      await i.reply({
        content:
          `Notifications on for #${ch.name}.`,
        ephemeral:true
      });
    }

  }catch(e){

    console.error(e);

    await i.reply({
      content:
        'Could not change the role. Make sure my bot role is above the NR roles.',
      ephemeral:true
    });
  }
}


/*
====================================================
STICKY ROLES
====================================================
*/

function isManagedRole(r){

  return !!r &&
    managedRoleIds().has(
      r.id
    );
}


async function sendSticky(
  channel,
  roleId
){

  const r=
    channel.guild.roles.cache.get(
      roleId
    );


  if(
    !r ||
    !isManagedRole(r)
  ){

    delete state.stickies[
      channel.id
    ];

    delete state.stickies[
      channel.id+'_message'
    ];

    saveState();

    return null;
  }


  const oldId=
    state.stickies[
      channel.id+'_message'
    ];


  if(oldId){

    const old=
      await channel.messages
        .fetch(oldId)
        .catch(()=>null);

    if(old){

      await old
        .delete()
        .catch(()=>{});

    }
  }


  const msg=
    await channel.send({

      content:
        r.toString(),

      allowedMentions:{
        roles:[r.id]
      }

    });


  state.stickies[
    channel.id+'_message'
  ]=msg.id;

  saveState();

  return msg;
}


async function handleStickyCommand(
  message
){

  if(
    !message.inGuild() ||
    message.guild.id!==GUILD_ID
  ){

    return false;
  }


  if(
    !/^!stick(?:\s|$)/i.test(
      message.content
    )
  ){

    return false;
  }


  if(
    !message.member.permissions.has(
      PermissionFlagsBits.ManageMessages
    )
  ){

    await message.reply(
      'You need Manage Messages to configure sticky roles.'
    );

    return true;
  }


  const r=
    message.mentions.roles.first();


  if(!r){

    await message.reply(
      'Use `!stick @role`.'
    );

    return true;
  }


  if(!isManagedRole(r)){

    await message.reply(
      'You can only stick notification roles created by this bot (`NR | ...`).'
    );

    return true;
  }


  state.stickies[
    message.channel.id
  ]=r.id;

  saveState();


  await sendSticky(
    message.channel,
    r.id
  );


  return true;
}


/*
====================================================
BOT READY
====================================================
*/

client.once(
  'ready',
  async()=>{

    console.log(
      `Logged in as ${client.user.tag}`
    );


    try{

      /*
      THIS registers /setup, /sync and /cleanup
      into Discord's UI before syncing.
      */

      await registerCommands();

      await sync();

    }catch(e){

      console.error(
        'Startup:',
        e
      );
    }


    setInterval(

      ()=>sync()
        .catch(
          e=>
            console.error(
              'Periodic sync:',
              e
            )
        ),

      SYNC_INTERVAL_MS

    );

  }
);


/*
====================================================
INTERACTIONS
====================================================
*/

client.on(
  'interactionCreate',
  async i=>{

    try{

      if(
        i.isChatInputCommand()
      ){

        if(
          i.commandName==='setup'
        ){

          return setupCommand(i);

        }


        if(
          i.commandName==='sync'
        ){

          return syncCommand(i);

        }


        if(
          i.commandName==='cleanup'
        ){

          return cleanupCommand(i);

        }

      }


      if(
        i.isButton() &&
        i.customId.startsWith(
          'notify:'
        )
      ){

        return toggle(i);

      }

    }catch(e){

      console.error(
        'Interaction:',
        e
      );


      if(
        !i.replied &&
        !i.deferred
      ){

        await i.reply({
          content:
            'Something went wrong.',
          ephemeral:true
        }).catch(()=>{});

      }
    }
  }
);


/*
====================================================
MESSAGE / STICKY HANDLER
====================================================
*/

client.on(
  'messageCreate',
  async message=>{

    try{

      if(
        message.author.bot
      ){

        return;
      }


      if(
        await handleStickyCommand(
          message
        )
      ){

        return;
      }


      if(
        !message.inGuild() ||
        message.guild.id!==GUILD_ID
      ){

        return;
      }


      const roleId=
        state.stickies[
          message.channel.id
        ];


      if(roleId){

        await sendSticky(
          message.channel,
          roleId
        );

      }

    }catch(e){

      console.error(
        'Sticky:',
        e.message
      );
    }
  }
);


/*
====================================================
AUTO-SYNC WHEN CHANNELS CHANGE
====================================================
*/

for(
  const ev of [
    'channelCreate',
    'channelDelete',
    'channelUpdate'
  ]
){

  client.on(
    ev,
    async ch=>{

      if(
        ch.guild?.id!==GUILD_ID
      ){

        return;
      }


      try{

        await sync();

      }catch(e){

        console.error(
          ev,
          e
        );
      }
    }
  );
}


/*
====================================================
ERROR HANDLERS
====================================================
*/

process.on(
  'unhandledRejection',
  e=>
    console.error(
      'Unhandled rejection:',
      e
    )
);

process.on(
  'uncaughtException',
  e=>
    console.error(
      'Uncaught exception:',
      e
    )
);


/*
====================================================
LOGIN
====================================================
*/

client.login(TOKEN);
