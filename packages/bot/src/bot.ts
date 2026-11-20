import { Bot, InlineKeyboard } from 'grammy';
import { SaccoEngine } from '../../core/src/engine.js';
import { safeLogger } from '../../core/src/utils/logger.js';
import { SaccoMember, SaccoGroup, SaccoCycle } from '../../core/src/types.js';

export function createTelegramBot(token: string, engine: SaccoEngine): Bot {
  const bot = new Bot(token);

  // /start command
  bot.command('start', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const keyboard = new InlineKeyboard()
      .text('🏛 Create Sacco', 'cmd_create_group')
      .text('📋 My Groups', 'cmd_my_groups')
      .row()
      .text('💡 How it Works', 'cmd_how_it_works')
      .text('⭐ My Reputation', 'cmd_my_reputation');

    await ctx.reply(
      `👋 **Welcome to Sats Sacco!**\n\n` +
      `Digitizing traditional savings circles (Chamas / Susus / Tandas) over Bitcoin Lightning and Nostr.\n\n` +
      `Save together with your community, build verifiable portable financial reputation, and receive lump sums with zero custodial risk.`,
      { reply_markup: keyboard, parse_mode: 'Markdown' }
    );
  });

  // /create command or callback
  bot.callbackQuery('cmd_create_group', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🚀 **Create a New Savings Circle**\n\n` +
      `Send the group details in this format:\n` +
      `\`/newgroup <GroupName> | <ContributionSats> | <IntervalHours> | <MaxMembers>\`\n\n` +
      `Example:\n\`/newgroup Nairobi Market Vendors | 10000 | 24 | 5\``,
      { parse_mode: 'Markdown' }
    );
  });

  // Handle /newgroup
  bot.command('newgroup', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const text = ctx.match;
    if (!text) {
      await ctx.reply('Please provide group parameters. Example:\n`/newgroup Nairobi Vendors | 10000 | 24 | 4`', { parse_mode: 'Markdown' });
      return;
    }

    const parts = text.split('|').map(s => s.trim());
    if (parts.length < 4) {
      await ctx.reply('Invalid format. Usage: `/newgroup Name | ContributionSats | IntervalHours | MaxMembers`', { parse_mode: 'Markdown' });
      return;
    }

    const [name, satsStr, hoursStr, maxStr] = parts;
    const contributionSats = parseInt(satsStr, 10);
    const intervalHours = parseInt(hoursStr, 10);
    const maxMembers = parseInt(maxStr, 10);

    if (isNaN(contributionSats) || isNaN(intervalHours) || isNaN(maxMembers)) {
      await ctx.reply('Sats, hours, and max members must be valid numbers.', { parse_mode: 'Markdown' });
      return;
    }

    const group = engine.createGroup({
      name,
      creator_tg_id: from.id,
      contribution_sats: contributionSats,
      cycle_interval_hours: intervalHours,
      max_members: maxMembers,
    });

    const joinKeyboard = new InlineKeyboard()
      .text('➕ Join Group', `join_${group.id}`)
      .row()
      .text('🔒 Lock & Start Circle', `start_${group.id}`);

    await ctx.reply(
      `✅ **Group "${group.name}" Created!**\n\n` +
      `• Contribution: **${group.contribution_sats.toLocaleString()} sats** per round\n` +
      `• Cycle Interval: **${group.cycle_interval_hours} hours**\n` +
      `• Max Members: **${group.max_members}**\n` +
      `• State: **FORMING**\n\n` +
      `Share this invite with members! Once everyone has joined with their Lightning payout address, press "Lock & Start Circle".`,
      { reply_markup: joinKeyboard, parse_mode: 'Markdown' }
    );
  });

  // Handle Join callback
  bot.callbackQuery(/^join_(.+)$/, async (ctx) => {
    const groupId = ctx.match[1];
    const from = ctx.from;
    await ctx.answerCallbackQuery();

    await ctx.reply(
      `To join this circle, reply with your Lightning Address (where your pot will be sent when it's your turn):\n` +
      `\`/join ${groupId} <yourname@getalby.com>\``,
      { parse_mode: 'Markdown' }
    );
  });

  // Handle /join command
  bot.command('join', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const parts = ctx.match.trim().split(' ');
    if (parts.length < 2) {
      await ctx.reply('Usage: `/join <groupId> <your-lightning-address>`', { parse_mode: 'Markdown' });
      return;
    }

    const [groupId, lnAddress] = parts;

    try {
      // Derive a deterministic dummy nostr pubkey if none provided
      const pseudoPubkey = `npub1${Buffer.from(String(from.id)).toString('hex').padStart(58, '0')}`;

      const member = engine.addMember({
        group_id: groupId,
        tg_id: from.id,
        tg_username: from.username,
        display_name: from.first_name || 'Member',
        nostr_pubkey: pseudoPubkey,
        lightning_address: lnAddress,
      });

      await ctx.reply(
        `🎉 **You have joined the circle!**\n\n` +
        `• Name: **${member.display_name}**\n` +
        `• Payout Address: \`${member.lightning_address}\`\n` +
        `• Verifiable Nostr Key: \`${member.nostr_pubkey.slice(0, 16)}...\`\n\n` +
        `You'll receive a notification when the coordinator locks the circle and opens round 1!`,
        { parse_mode: 'Markdown' }
      );
    } catch (err: unknown) {
      await ctx.reply(`❌ Could not join group: ${(err as Error).message}`);
    }
  });

  // Handle start group callback
  bot.callbackQuery(/^start_(.+)$/, async (ctx) => {
    const groupId = ctx.match[1];
    await ctx.answerCallbackQuery();

    try {
      const activeGroup = await engine.activateGroup(groupId);
      const cycle = await engine.openCycle(groupId);
      const members = engine.db.prepare('SELECT * FROM members WHERE group_id = ? ORDER BY rotation_index ASC').all(groupId) as SaccoMember[];
      const beneficiary = members.find(m => m.id === cycle.beneficiary_member_id);

      await ctx.reply(
        `🔒 **Circle Locked & Round 1 is OPEN!**\n\n` +
        `🎯 **Beneficiary for Round 1:** **${beneficiary?.display_name}**\n` +
        `💰 **Target Pot:** **${cycle.pot_target_sats.toLocaleString()} sats**\n\n` +
        `**Rotation Order:**\n` +
        members.map(m => `${(m.rotation_index || 0) + 1}. ${m.display_name} ${m.id === beneficiary?.id ? '⭐ (First pot)' : ''}`).join('\n') +
        `\n\nInvoices have been generated. Tap below to view your invoice.`,
        {
          reply_markup: new InlineKeyboard().text('⚡ View My Payment Invoice', `my_invoice_${cycle.id}`),
          parse_mode: 'Markdown',
        }
      );
    } catch (err: unknown) {
      await ctx.reply(`❌ Could not start group: ${(err as Error).message}`);
    }
  });

  // View member invoice
  bot.callbackQuery(/^my_invoice_(.+)$/, async (ctx) => {
    const cycleId = ctx.match[1];
    const from = ctx.from;
    await ctx.answerCallbackQuery();

    const member = engine.db.prepare('SELECT * FROM members WHERE tg_id = ?').get(from.id) as SaccoMember;
    if (!member) {
      await ctx.reply('You are not registered in this circle.');
      return;
    }

    const contrib = engine.db.prepare('SELECT * FROM contributions WHERE cycle_id = ? AND member_id = ?').get(cycleId, member.id) as any;
    if (!contrib || !contrib.invoice_bolt11) {
      await ctx.reply('No active invoice found for your account in this round.');
      return;
    }

    await ctx.reply(
      `⚡ **Cycle Contribution Invoice**\n\n` +
      `Amount: **${contrib.amount_sats.toLocaleString()} sats**\n` +
      `Status: **${contrib.state}**\n\n` +
      `Copy and pay this Lightning invoice in any wallet:\n\n` +
      `\`${contrib.invoice_bolt11}\``,
      { parse_mode: 'Markdown' }
    );
  });

  // General error handler
  bot.catch((err) => {
    safeLogger.error('Telegram bot error', { error: err.message });
  });

  return bot;
}

