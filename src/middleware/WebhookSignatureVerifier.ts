import { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { Logger } from '../utils/logger';
import { config } from '../config/config';

export class WebhookSignatureVerifier {
  private static logger = new Logger('WebhookSignatureVerifier');

  /**
   * Constant-time string comparison. Both operands must be present — an absent
   * value is never "equal", which is what previously made an unconfigured
   * secret accept unauthenticated requests.
   */
  private static safeEqual(a?: string, b?: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  static async verify(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const signature = request.headers['x-telegram-bot-api-signature'] as string;
    const secret = request.headers['x-telegram-bot-api-secret-token'] as string;

    // No configured secret means the endpoint cannot authenticate anything.
    // Reject rather than accept: the old code compared undefined to undefined,
    // found them "equal", and let any caller who knew the URL post updates.
    if (!config.bot.webhookSecret) {
      this.logger.error(
        'Webhook rejected: BOT_WEBHOOK_SECRET is not configured, so incoming updates cannot be authenticated'
      );
      reply.code(404).send({ error: 'Not found' });
      return false;
    }

    // Check the secret token (constant-time to avoid timing attacks)
    if (!this.safeEqual(secret, config.bot.webhookSecret)) {
      this.logger.warn('Invalid webhook secret token');
      reply.code(404).send({ error: 'Not found' });
      return false;
    }

    // If signature header is provided, verify it (constant-time)
    if (signature) {
      const body = JSON.stringify(request.body);
      const expectedSignature = createHmac('sha256', config.bot.webhookSecret || '')
        .update(body)
        .digest('hex');

      if (!this.safeEqual(signature, `sha256=${expectedSignature}`)) {
        this.logger.warn('Invalid webhook signature');
        reply.code(404).send({ error: 'Not found' });
        return false;
      }
    }

    return true;
  }

  static generateSignature(body: string): string {
    return `sha256=${createHmac('sha256', config.bot.webhookSecret || '')
      .update(body)
      .digest('hex')}`;
  }
}