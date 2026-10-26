# Standalone Discord Notification Bot

This project is intentionally independent from the trial bot.

## Features
- Dynamic category/channel discovery
- Categories and channels sorted A-Z
- Fresh `NR | channel-name` roles
- Button toggles for notification roles
- Green/gray subscription state is reflected per user when they interact
- Rename channel -> rename notification role
- Delete channel -> delete notification role
- Move channel -> preserve role, update panel location
- Periodic reconciliation after restarts/changes
- Persistent multi-message dashboard; edits existing messages instead of reposting the whole panel
- Only manages roles with the configured `ROLE_PREFIX`
- Role-limit safety check

## Discord permissions
Manage Roles, View Channels, Send Messages, Embed Links, Read Message History, Use Application Commands.

The bot's highest role must be above the `NR | ...` roles it creates.

## Setup
1. Copy `.env.example` to `.env`.
2. Put the NEW bot token/application ID/server ID in `.env`.
3. `npm install`
4. `npm start`
5. In the desired panel channel run `/setup`.

## Railway
Deploy this as a completely separate Railway service from the trial bot. Do not reuse the trial bot token, database, source files, or environment variables.

The state file is stored under `/app/data`. A Railway volume mounted at `/app/data` is recommended so panel message IDs survive redeploys. Even without it, `/setup` can rebuild the dashboard from Discord.


## Sticky role mentions

A moderator/admin with Manage Messages can run `!stick @role` in a channel. The role must be one of this bot's `NR | ...` notification roles. The bot posts the role mention and keeps it at the bottom by moving the sticky back down whenever a new message is sent. Running the command again replaces the existing sticky. The command message is deleted after setup.
