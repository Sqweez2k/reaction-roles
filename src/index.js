require('dotenv').config();
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
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
}=require('discord.js');

const TOKEN=process.env.DISCORD_TOKEN;
const CLIENT_ID=process.env.CLIENT_ID;
const GUILD_ID=process.env.GUILD_ID;
const PANEL_CHANNEL_ID=process.env.PANEL_CHANNEL_ID||'';
const SYNC_INTERVAL_MS=Math.max(15000,Number(process.env.SYNC_INTERVAL_MS||60000));
const ROLE_PREFIX=process.env.ROLE_PREFIX||'NR | ';

// Categories excluded from the notification-role system.
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

function defaultState(){
  return {
    guildId:GUILD_ID,
    panelChannelId:PANEL_CHANNEL_ID||null,
    panelMessageIds:[],
    panelHash:null,
    channelRoles:{},
    stickies:{},
    lastSyncAt:null
  };
}

function loadState(){
  fs.mkdirSync(DATA_DIR,{recursive:true});

  if(!fs.existsSync(STATE_FILE)){
    const s=defaultState();
    fs.writeFileSync(STATE_FILE,JSON.stringify(s,null,2));
    return s;
  }

  try{
    return {
      ...defaultState(),
      ...JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))
    };
  }catch{
    return defaultState();
  }
}

let state=loadState();

function saveState(){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  const t=STATE_FILE+'.tmp';
  fs.writeFileSync(t,JSON.stringify(state,null,2));
  fs.renameSync(t,STATE_FILE);
}

const hash=v=>crypto.createHash('sha256').update(v).digest('hex');

const cleanName=n=>
  n.replace(/[\r\n]+/g,' ')
   .replace(/\s+/g,' ')
   .trim()
   .slice(0,90);

const supported=new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia
]);

const alpha=(a,b)=>
  a.name.localeCompare(b.name,undefined,{
    sensitivity:'base',
    numeric:true
  });

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

async function registerCommands(){
  const commands=[
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Create or repair the notification dashboard in this channel.'),

    new SlashCommandBuilder()
      .setName('sync')
      .setDescription('Synchronize notification roles and the dashboard with the server.')
  ].map(x=>x.toJSON());

  const rest=new REST({version:'10'}).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID,GUILD_ID),
    {body:commands}
  );
}

async function getGuild(){
  return client.guilds.fetch(GUILD_ID);
}

async function channels(guild){
  return [...(await guild.channels.fetch()).values()].filter(Boolean);
}

function structureOf(all){

  const cats=all
    .filter(c=>c.type===ChannelType.GuildCategory)
    .filter(c=>!EXCLUDED_CATEGORY_IDS.has(c.id))
    .sort(alpha);

  const out=[];

  for(const cat of cats){

    const children=all
      .filter(c=>
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
    .filter(c=>!c.parentId&&supported.has(c.type))
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
  return new Set(Object.values(state.channelRoles));
}

async function findExistingRole(guild,desired,ch){

  const mappedId=state.channelRoles[ch.id];

  if(mappedId){
    const mapped=guild.roles.cache.get(mappedId);
    if(mapped) return mapped;
  }

  const existing=guild.roles.cache.find(
    r=>r.name===desired
  );

  if(existing){
    state.channelRoles[ch.id]=existing.id;
    saveState();
    return existing;
  }

  return null;
}

async function ensureRole(guild,ch){

  const desired=ROLE_PREFIX+cleanName(ch.name);

  let role=await findExistingRole(
    guild,
    desired,
    ch
  );

  if(role){

    if(role.name!==desired){
      try{
        await role.setName(
          desired,
          'Notification channel renamed'
        );
      }catch(e){
        console.error(
          'Role rename:',
          e.message
        );
      }
    }

    state.channelRoles[ch.id]=role.id;

    return role;
  }

  if(guild.roles.cache.size>=250){
    throw new Error(
      `Discord role limit reached; cannot create ${desired}.`
    );
  }

  try{

    role=await guild.roles.create({
      name:desired,
      reason:'Notification dashboard role'
    });

    state.channelRoles[ch.id]=role.id;
    saveState();

    return role;

  }catch(e){

    console.error(
      `Role create for ${ch.name}:`,
      e.message
    );

    return null;
  }
}

async function cleanup(guild,all){

  const eligible=structureOf(all);

  const live=new Set(
    eligible.flatMap(
      g=>g.channels.map(c=>c.id)
    )
  );

  for(const [cid,rid] of Object.entries(state.channelRoles)){

    if(live.has(cid)) continue;

    const role=guild.roles.cache.get(rid);

    if(role){
      await role.delete(
        'Notification channel deleted'
      ).catch(e=>{
        console.error(
          'Role delete:',
          e.message
        );
      });
    }

    delete state.channelRoles[cid];
  }

  saveState();
}

function render(structure){

  const msgs=[];

  // ONE CATEGORY PER DISCORD MESSAGE.
  // If a category has more than 25 channels,
  // only that same category is split across messages.

  for(const group of structure){

    for(
      let offset=0;
      offset<group.channels.length;
      offset+=25
    ){

      const page=group.channels.slice(
        offset,
        offset+25
      );

      const rows=[];

      for(let i=0;i<page.length;i+=5){

        const row=new ActionRowBuilder();

        for(const ch of page.slice(i,i+5)){

          row.addComponents(
            new ButtonBuilder()
              .setCustomId(
                'notify:'+ch.id
              )
              .setLabel(
                cleanName(ch.name).slice(0,80)
              )
              .setStyle(ButtonStyle.Secondary)
          );
        }

        rows.push(row);
      }

      msgs.push({

        embeds:[
          new EmbedBuilder()
            .setTitle(group.category.name)
            .setDescription(
              'Click a channel to toggle its notifications.'
            )
        ],

        components:rows,

        signature:[
          `CAT:${group.category.id}:${group.category.name}`,
          page.map(ch=>
            `${ch.id}:${ch.name}:${state.channelRoles[ch.id]||''}`
          ).join('|')
        ].join('||')
      });
    }
  }

  return msgs;
}

async function sync({forcePanel=false}={}){

  const guild=await getGuild();

  await guild.roles.fetch();

  const all=await channels(guild);

  const structure=structureOf(all);

  await cleanup(guild,all);

  let warning=null;

  for(const g of structure){

    for(const ch of g.channels){

      try{
        await ensureRole(guild,ch);
      }catch(e){
        warning=e.message;
      }
    }
  }

  state.lastSyncAt=new Date().toISOString();

  saveState();

  const pcid=
    state.panelChannelId||
    PANEL_CHANNEL_ID;

  if(!pcid){
    return {
      structure,
      warning,
      updated:false
    };
  }

  const pc=
    await guild.channels
      .fetch(pcid)
      .catch(()=>null);

  if(!pc?.isTextBased()){
    return {
      structure,
      warning,
      updated:false
    };
  }

  const rendered=render(structure);

  const rh=hash(
    JSON.stringify(
      rendered.map(x=>x.signature)
    )
  );

  if(
    !forcePanel &&
    state.panelHash===rh &&
    state.panelMessageIds.length===rendered.length
  ){
    return {
      structure,
      warning,
      updated:false
    };
  }

  const old=[
    ...state.panelMessageIds
  ];

  const ids=[];

  for(let i=0;i<rendered.length;i++){

    let m=old[i]
      ? await pc.messages
          .fetch(old[i])
          .catch(()=>null)
      : null;

    const payload={
      embeds:rendered[i].embeds,
      components:rendered[i].components
    };

    if(m){

      await m.edit(payload);

    }else{

      m=await pc.send(payload);

    }

    ids.push(m.id);
  }

  for(
    let i=rendered.length;
    i<old.length;
    i++
  ){

    const m=
      await pc.messages
        .fetch(old[i])
        .catch(()=>null);

    if(m){
      await m.delete().catch(()=>{});
    }
  }

  state.panelMessageIds=ids;
  state.panelHash=rh;

  saveState();

  return {
    structure,
    warning,
    updated:true
  };
}

async function setup(i){

  if(
    !i.inGuild()||
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

  state.panelChannelId=i.channelId;

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
        (x,g)=>x+g.channels.length,
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

async function manualSync(i){

  await i.deferReply({
    ephemeral:true
  });

  try{

    const r=await sync();

    const n=
      r.structure.reduce(
        (x,g)=>x+g.channels.length,
        0
      );

    await i.editReply(
      `Sync complete — ${n} channels checked. Panel changed: ${r.updated?'yes':'no'}.`+
      (r.warning
        ? `\nWarning: ${r.warning}`
        : '')
    );

  }catch(e){

    console.error(e);

    await i.editReply(
      'Sync failed: '+e.message
    );
  }
}

async function toggle(i){

  const cid=
    i.customId.slice(7);

  const guild=i.guild;

  const ch=
    guild.channels.cache.get(cid)||
    await guild.channels
      .fetch(cid)
      .catch(()=>null);

  if(
    !ch||
    !supported.has(ch.type)||
    !ch.parentId||
    EXCLUDED_CATEGORY_IDS.has(ch.parentId)
  ){

    return i.reply({
      content:
        'That channel is not available for notifications.',
      ephemeral:true
    });
  }

  let role=
    state.channelRoles[cid]
      ? guild.roles.cache.get(
          state.channelRoles[cid]
        )
      : null;

  if(!role){
    role=await ensureRole(guild,ch);
  }

  if(!role){

    return i.reply({
      content:
        'I could not create/find that notification role.',
      ephemeral:true
    });
  }

  try{

    if(i.member.roles.cache.has(role.id)){

      await i.member.roles.remove(role);

      await i.reply({
        content:
          `Notifications off for #${ch.name}.`,
        ephemeral:true
      });

    }else{

      await i.member.roles.add(role);

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

/* STICKY ROLES */

function isManagedRole(role){
  return role &&
    managedRoleIds().has(role.id);
}

async function sendSticky(channel,roleId){

  const role=
    channel.guild.roles.cache.get(roleId);

  if(!role||!isManagedRole(role)){

    delete state.stickies[channel.id];

    saveState();

    return null;
  }

  const oldId=
    state.stickies[channel.id+'_message'];

  if(oldId){

    const old=
      await channel.messages
        .fetch(oldId)
        .catch(()=>null);

    if(old){
      await old.delete().catch(()=>{});
    }
  }

  const msg=
    await channel.send({
      content:role.toString(),
      allowedMentions:{
        roles:[role.id]
      }
    });

  state.stickies[
    channel.id+'_message'
  ]=msg.id;

  saveState();

  return msg;
}

async function handleStickyCommand(message){

  if(
    !message.inGuild()||
    message.guild.id!==GUILD_ID
  ){
    return false;
  }

  if(
    !message.content
      .toLowerCase()
      .startsWith('!stick')
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

  const role=
    message.mentions.roles.first();

  if(!role){

    await message.reply(
      'Use `!stick @role`.'
    );

    return true;
  }

  if(!isManagedRole(role)){

    await message.reply(
      'You can only stick notification roles created by this bot (`NR | ...`).'
    );

    return true;
  }

  state.stickies[
    message.channel.id
  ]=role.id;

  saveState();

  await sendSticky(
    message.channel,
    role.id
  );

  return true;
}

client.once('ready',async()=>{

  console.log(
    `Logged in as ${client.user.tag}`
  );

  try{

    await registerCommands();

    await sync();

  }catch(e){

    console.error(
      'Startup:',
      e
    );
  }

  setInterval(
    ()=>sync().catch(
      e=>console.error(
        'Periodic sync:',
        e
      )
    ),
    SYNC_INTERVAL_MS
  );
});

client.on(
  'interactionCreate',
  async i=>{

    try{

      if(i.isChatInputCommand()){

        if(i.commandName==='setup'){
          return setup(i);
        }

        if(i.commandName==='sync'){
          return manualSync(i);
        }
      }

      if(
        i.isButton()&&
        i.customId.startsWith('notify:')
      ){
        return toggle(i);
      }

    }catch(e){

      console.error(
        'Interaction:',
        e
      );

      if(!i.replied&&!i.deferred){

        await i.reply({
          content:
            'Something went wrong.',
          ephemeral:true
        }).catch(()=>{});
      }
    }
  }
);

client.on(
  'messageCreate',
  async message=>{

    try{

      if(message.author.bot){
        return;
      }

      if(
        await handleStickyCommand(message)
      ){
        return;
      }

      if(
        !message.inGuild()||
        message.guild.id!==GUILD_ID
      ){
        return;
      }

      const roleId=
        state.stickies[
          message.channel.id
        ];

      if(!roleId){
        return;
      }

      await sendSticky(
        message.channel,
        roleId
      );

    }catch(e){

      console.error(
        'Sticky:',
        e.message
      );
    }
  }
);

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

process.on(
  'unhandledRejection',
  e=>console.error(
    'Unhandled rejection:',
    e
  )
);

process.on(
  'uncaughtException',
  e=>console.error(
    'Uncaught exception:',
    e
  )
);

client.login(TOKEN);
