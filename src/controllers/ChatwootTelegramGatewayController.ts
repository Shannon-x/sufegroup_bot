import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { ChatwootVerificationService } from '../services/ChatwootVerificationService';
import { config } from '../config/config';
import { Logger } from '../utils/logger';

interface TelegramUserSnapshot {
  id: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  chatId: number | string;
}

export class ChatwootTelegramGatewayController {
  private verificationService: ChatwootVerificationService;
  private logger: Logger;

  constructor() {
    this.verificationService = new ChatwootVerificationService();
    this.logger = new Logger('ChatwootTelegramGatewayController');
  }

  async register(fastify: FastifyInstance) {
    fastify.post('/chatwoot/telegram-webhook', async (request, reply) => {
      if (!this.isConfigured(reply)) return;
      if (!this.authenticateTelegram(request, reply)) return;

      const update = request.body as Record<string, any>;
      const user = this.extractPrivateUser(update);

      if (!user) {
        return this.forwardToChatwoot(update, reply);
      }

      const gate = await this.verificationService.gate({
        inboxId: config.chatwootVerification.gatewayInboxId,
        userId: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
      });

      if (gate.allowed) {
        return this.forwardToChatwoot(update, reply);
      }

      if (gate.promptAllowed) {
        await this.sendVerificationPrompt(user.chatId, gate.verificationUrl);
      }

      this.logger.info('Blocked unverified Chatwoot Telegram message', {
        inboxId: config.chatwootVerification.gatewayInboxId,
        userId: user.id,
        status: gate.status,
      });

      return reply.send({ ok: true, blocked: true });
    });
  }

  private isConfigured(reply: FastifyReply): boolean {
    if (
      !config.chatwootVerification.gatewayBaseUrl ||
      !config.chatwootVerification.gatewayTelegramBotToken ||
      !config.chatwootVerification.gatewayWebhookSecret ||
      !config.bot.username ||
      !config.bot.miniAppShortName
    ) {
      reply.code(503).send({ ok: false, error: 'Chatwoot Telegram gateway is not configured' });
      return false;
    }

    return true;
  }

  private authenticateTelegram(request: FastifyRequest, reply: FastifyReply): boolean {
    const expected = config.chatwootVerification.gatewayWebhookSecret;
    const provided = request.headers['x-telegram-bot-api-secret-token'] as string | undefined;

    if (!expected || !provided || !this.safeEqual(provided, expected)) {
      reply.code(404).send({ ok: false, error: 'Not found' });
      return false;
    }

    return true;
  }

  private async forwardToChatwoot(update: Record<string, any>, reply: FastifyReply) {
    const baseUrl = config.chatwootVerification.gatewayBaseUrl!.replace(/\/$/, '');
    const botToken = config.chatwootVerification.gatewayTelegramBotToken!;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.chatwootVerification.gatewayForwardTimeoutSeconds * 1000
    );

    try {
      const response = await fetch(`${baseUrl}/webhooks/telegram/${encodeURIComponent(botToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn('Chatwoot Telegram webhook returned non-success', {
          status: response.status,
        });
        return reply.code(502).send({ ok: false, error: 'Chatwoot webhook failed' });
      }

      return reply.send({ ok: true, forwarded: true });
    } catch (error) {
      this.logger.error('Failed to forward Telegram update to Chatwoot', error);
      return reply.code(502).send({ ok: false, error: 'Chatwoot webhook unavailable' });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sendVerificationPrompt(chatId: number | string, verificationUrl: string) {
    const botToken = config.chatwootVerification.gatewayTelegramBotToken!;
    const text = '为了拦截广告和机器人，请先完成人机验证。验证通过后，请重新发送您的消息。';

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: [[
            { text: '🔐 完成人机验证', url: verificationUrl },
          ]],
        },
      }),
    });
  }

  private extractPrivateUser(update: Record<string, any>): TelegramUserSnapshot | null {
    const message = update.message || update.business_message;
    if (!message || message.chat?.type !== 'private' || !message.from?.id) return null;

    return {
      id: String(message.from.id),
      username: message.from.username,
      firstName: message.from.first_name,
      lastName: message.from.last_name,
      chatId: message.chat.id,
    };
  }

  private safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}
