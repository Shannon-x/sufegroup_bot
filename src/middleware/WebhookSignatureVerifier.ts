import { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { Logger } from '../utils/logger';
import { config } from '../config/config';

export class WebhookSignatureVerifier {
  private static logger = new Logger('WebhookSignatureVerifier');

  /**
   * Constant-time string comparison. Returns true iff both strings are equal.
   * Handles undefined (both undefined → equal, preserving "no secret configured" semantics).
   */
  private static safeEqual(a?: string, b?: string): boolean {
    if (a === undefined || b === undefined) return a === b;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  static async verify(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const signature = request.headers['x-telegram-bot-api-signature'] as string;
    const secret = request.headers['x-telegram-bot-api-secret-token'] as string;

    // First check the secret token (constant-time to avoid timing attacks)
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
    return `sha256=${createHmac('sha256', config.bot.webhookSecret)
      .update(body)
      .digest('hex')}`;
  }
}