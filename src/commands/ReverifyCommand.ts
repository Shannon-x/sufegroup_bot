import { CommandContext } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { BaseCommand } from './BaseCommand';
import { MyContext } from '../services/TelegramBot';

export class ReverifyCommand extends BaseCommand {
  command = 'reverify';
  description = '为指定用户重新发送验证消息（管理员专用）';

  setup() {
    this.bot.command(this.command, async (ctx) => this.execute(ctx));
  }

  private async execute(ctx: CommandContext<MyContext>) {
    if (!await this.requireGroup(ctx)) return;
    // Status-only on purpose: this is the recovery path for a member who is
    // muted with no working verification link. It grants nothing by itself (the
    // target still has to pass the captcha), and gating it behind a permission
    // bit would also lock out anonymous admins — see BaseCommand.checkAdmin.
    if (!await this.requireAdmin(ctx)) return;

    const groupId = ctx.chat!.id.toString();
    const replyTo = ctx.message?.message_id;

    try {
      // Accepts `@name`, a numeric id, or a reply to the target's message.
      const { userId, username } = await this.resolveTarget(ctx);
      if (!userId) {
        await ctx.reply(
          username
            ? `❌ 找不到用户 @${username}\n请确保该用户曾在本群发言，或改用回复其消息的方式`
            : '❌ 用法: /reverify @username 或 /reverify <用户ID>，也可回复该用户的消息',
          { reply_to_message_id: replyTo }
        );
        return;
      }

      const user = await this.userService.findById(userId);
      if (!user) {
        await ctx.reply('❌ 找不到该用户', { reply_to_message_id: replyTo });
        return;
      }

      // Check if user is in the group and restricted
      try {
        const member = await ctx.api.getChatMember(Number(groupId), Number(userId));
        if (member.status === 'left' || member.status === 'kicked') {
          await ctx.reply('❌ 该用户不在群组中', { reply_to_message_id: replyTo });
          return;
        }

        if (member.status !== 'restricted') {
          await ctx.reply('❌ 该用户未被限制，不需要验证', { reply_to_message_id: replyTo });
          return;
        }
      } catch (error) {
        await ctx.reply('❌ 无法获取用户状态', { reply_to_message_id: replyTo });
        return;
      }

      // Get group settings
      const settings = await this.groupService.getSettings(groupId);
      if (!settings || !settings.verificationEnabled) {
        await ctx.reply('❌ 该群组未启用验证功能', { reply_to_message_id: replyTo });
        return;
      }

      // Retiring the previous session is a question of *when*, and both extremes
      // are wrong:
      //  - retiring it after the send (previous version) left an already-expired
      //    session claimable by the cleanup scheduler for the whole sendMessage
      //    round-trip, so the user could be kicked while we were re-inviting
      //    them;
      //  - retiring it before the send strands a user whose link was still valid
      //    if the send then fails.
      // Only an expired session is claimable, so that one is retired up front
      // and a still-valid one is kept until the new link is actually delivered.
      const existingSession = await this.verificationService.getPendingSession(userId, groupId);
      const staleSession =
        existingSession && existingSession.expiresAt.getTime() <= Date.now() ? existingSession : null;
      if (staleSession) {
        await this.verificationService.cancelSession(staleSession.id);
      }

      const session = await this.verificationService.createSession(
        userId,
        groupId,
        0,
        settings.ttlMinutes
      );
      // The member is restricted (verified above), so this is accurate.
      await this.verificationService
        .markRestrictionApplied(session.id, true)
        .catch((e) => this.logger.warn('Could not mark restriction applied', e));

      // Never post the raw verification URL: it is an identity-free bearer
      // token and this message goes to the whole group. See
      // BaseCommand.buildVerificationDeepLink.
      const deepLink = this.buildVerificationDeepLink(session.id);
      if (!deepLink) {
        await this.verificationService.cancelSession(session.id).catch(() => {});
        await ctx.reply('❌ 机器人未配置用户名（BOT_USERNAME），无法生成验证入口', {
          reply_to_message_id: replyTo
        });
        return;
      }

      const welcomeText = this.renderWelcomeTemplate(settings.welcomeTemplate, {
        userName: user.firstName || '用户',
        groupName: ctx.chat!.title || '本群',
        ttlMinutes: settings.ttlMinutes,
      });

      const keyboard = new InlineKeyboard().url('🔐 点击验证', deepLink);

      let message;
      try {
        message = await ctx.api.sendMessage(Number(groupId), welcomeText, {
          reply_markup: keyboard,
          parse_mode: 'HTML'
        });
      } catch (sendError) {
        // Roll the new session back so we don't leave a second pending session
        // behind, and report the failure instead of claiming success.
        this.logger.error('Failed to deliver re-verification message', sendError);
        await this.verificationService.cancelSession(session.id).catch(() => {});
        await ctx.reply('❌ 验证消息发送失败，请检查机器人发言权限后重试', {
          reply_to_message_id: replyTo
        });
        return;
      }

      // Field-level updates, never save(entity). The in-memory session is a
      // snapshot taken before the send round-trip; writing the whole row back
      // would clobber any status/removalAttempts the scheduler set meanwhile.
      await this.verificationService.updateSessionMessageId(session.id, message.message_id);

      // The user now holds a working link, so a still-valid predecessor can be
      // retired without any risk of stranding them.
      if (existingSession && !staleSession) {
        await this.verificationService.cancelSession(existingSession.id);
      }

      // Log action
      await this.auditService.log({
        groupId,
        userId: userId,
        performedBy: ctx.from!.id.toString(),
        action: 'reverify_triggered',
        details: `Admin manually triggered re-verification for user ${user.username || user.firstName}`
      });

      await ctx.reply('✅ 已为该用户重新发送验证消息', { reply_to_message_id: replyTo });

      // Delete command message
      try {
        await ctx.deleteMessage();
      } catch (error) {
        // Ignore if can't delete
      }

    } catch (error) {
      this.logger.error('Error in reverify command', error);
      await ctx.reply('❌ 发送验证消息时出错', { reply_to_message_id: replyTo });
    }
  }
}
