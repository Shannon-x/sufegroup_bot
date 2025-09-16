import { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac } from 'crypto';
import { Logger } from '../utils/logger';
import { config } from '../config/config';

export class WebhookSignatureVerifier {
  private static logger = new Logger('WebhookSignatureVerifier');

  static async verify(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const signature = request.headers['x-telegram-bot-api-signature'] as string;
    const secret = request.headers['x-telegram-bot-api-secret-token'] as string;

    // First check the secret token
    if (secret !== config.bot.webhookSecret) {
      this.logger.warn('Invalid webhook secret token');
      reply.code(404).send({ error: 'Not found' });
      return false;
    }

    // If signature header is provided, verify it
    if (signature) {
      const body = JSON.stringify(request.body);
      const expectedSignature = createHmac('sha256', config.bot.webhookSecret)
        .update(body)
        .digest('hex');

      if (signature !== `sha256=${expectedSignature}`) {
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