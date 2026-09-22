import { CommandContext } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';
import { describeMessage } from '../utils/messageSample';
import { escapeHtml } from '../utils/markdown';

/** Telegram's anonymous-admin placeholder account. */
const GROUP_ANONYMOUS_BOT_ID = 1087968824;

/**
 * /spam — reply to a message to remove it, ban its sender, and record it.
 *
 * Two gaps this closes:
 *
 * It is the only way to deal with an advertising *bot* already in the group.
 * Telegram never delivers one bot's messages to another, so this bot cannot
 * see such a bot post, and only removes bots at the moment they join. But when
 * an admin replies to the bot's message, the update carries the replied-to
 * message in full — including who sent it.
 *
 * And it turns every miss into a sample. The filter improves only when someone
 * records what got past it; this logs the reported message whole (text, hidden
 * links, buttons, borrowed quotes) under a single searchable event, so the
 * next rule can be written from real examples rather than guesses.
 */
export class SpamCommand extends BaseCommand {
  command = 'spam';
  description = '回复广告消息：删除、封禁发送者并记录样本（管理员）';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!ctx.chat || ctx.chat.type === 'private') return;
    if (!await this.requireAdmin(ctx, ['can_restrict_members', 'can_delete_messages'])) return;

    const target = ctx.message?.reply_to_message;
    if (!target) {
      await ctx.reply('用法：回复一条广告消息，然后发送 /spam');
      return;
    }

    const chatId = ctx.chat.id;
    const sender = target.from;
    const senderChat = target.sender_chat;

    // Refuse targets that must never be banned from here.
    if (sender?.id === ctx.me.id) {
      await ctx.reply('❌ 不能对机器人自己执行此操作');
      return;
    }
    const postedAsThisGroup = senderChat?.id === chatId || sender?.id === GROUP_ANONYMOUS_BOT_ID;
    if (postedAsThisGroup) {
      await ctx.reply('❌ 这是以群组身份发送的消息（匿名管理员），无法封禁');
      return;
    }
    if (sender && !senderChat) {
      const status = await ctx.api
        .getChatMember(chatId, sender.id)
        .then((m) => m.status)
        .catch(() => undefined);
      if (status === 'administrator' || status === 'creator') {
        await ctx.reply('❌ 不能对管理员执行此操作');
        return;
      }
    }

    const reporter = ctx.from?.id;

    // Record first: even if the ban fails, the sample is what improves the filter.
    this.logger.warn('Spam reported by admin', {
      event: 'spam_report',
      chatId,
      reportedBy: reporter,
      sample: describeMessage(target),
    });

    const deleted = await ctx.api
      .deleteMessage(chatId, target.message_id)
      .then(() => true)
      .catch((error) => {
        this.logger.warn('Could not delete reported message', { chatId, error: String(error) });
        return false;
      });

    let banned = false;
    let banError: string | undefined;
    try {
      if (senderChat) {
        // A channel posting in the group: banning the channel stops every
        // account that posts as it, which banning a user id would not.
        await ctx.api.banChatSenderChat(chatId, senderChat.id);
      } else if (sender) {
        await ctx.api.banChatMember(chatId, sender.id);
      }
      banned = Boolean(sender || senderChat);
    } catch (error) {
      banError = error instanceof Error ? error.message : String(error);
      this.logger.error('Could not ban reported sender', { chatId, error: banError });
    }

    if (banned && sender && !senderChat) {
      await this.verificationService
        .addToBlacklist(String(sender.id), String(chatId), String(reporter ?? ''), 'Reported as spam via /spam')
        .catch((error) => this.logger.warn('Could not blacklist reported sender', error));
    }

    await this.auditService
      .log({
        groupId: String(chatId),
        userId: sender && !senderChat ? String(sender.id) : undefined,
        performedBy: reporter ? String(reporter) : undefined,
        action: 'spam_reported',
        details: `deleted=${deleted} banned=${banned}${banError ? ` error=${banError}` : ''}`,
        metadata: { sample: describeMessage(target) },
      })
      .catch((error) => this.logger.warn('Could not write spam report audit', error));

    // Keep the chat clean: the command itself is noise once handled.
    await ctx.deleteMessage().catch(() => undefined);

    const who = senderChat
      ? ('title' in senderChat && senderChat.title) || String(senderChat.id)
      : sender?.username
        ? `@${sender.username}`
        : sender?.first_name ?? '未知';
    const kind = sender?.is_bot ? '机器人' : senderChat ? '频道' : '用户';

    const text = banned
      ? `🧹 已处理广告：${kind} ${escapeHtml(who)} 已封禁${deleted ? '，消息已删除' : ''}。`
      : `⚠️ 已记录该广告，但未能封禁 ${kind} ${escapeHtml(who)}，请检查机器人的「封禁成员」权限。`;

    await ctx.api
      .sendMessage(chatId, text, { parse_mode: 'HTML' })
      .then((msg) => {
        setTimeout(() => {
          ctx.api.deleteMessage(chatId, msg.message_id).catch(() => undefined);
        }, 30_000).unref?.();
      })
      .catch(() => undefined);
  }
}
