import { FastifyRequest, FastifyReply } from 'fastify';
import { Logger } from '../utils/logger';

export class TelegramIpWhitelist {
  private static logger = new Logger('TelegramIpWhitelist');

  // Telegram's webhook IP ranges
  private static readonly TELEGRAM_IP_RANGES = [
    // 149.154.160.0/20
    { start: 0x959aa000, end: 0x959affff },
    // 91.108.4.0/22
    { start: 0x5b6c0400, end: 0x5b6c07ff }
  ];

  static async verify(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const forwardedFor = request.headers['x-forwarded-for'] as string;
    const remoteIp = forwardedFor ? forwardedFor.split(',')[0].trim() : request.ip;

    if (!remoteIp) {
      this.logger.warn('No IP address found in request');
      reply.code(404).send({ error: 'Not found' });
      return false;
    }

    const ipNum = this.ipToNumber(remoteIp);
    if (ipNum === null) {
      this.logger.warn('Invalid IP address format', { ip: remoteIp });
      reply.code(404).send({ error: 'Not found' });
      return false;
    }

    const isWhitelisted = this.TELEGRAM_IP_RANGES.some(range =>
      ipNum >= range.start && ipNum <= range.end
    );

    if (!isWhitelisted) {
      this.logger.warn('Request from non-Telegram IP', { ip: remoteIp });
      reply.code(404).send({ error: 'Not found' });
      return false;
    }

    return true;
  }

  private static ipToNumber(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;

    let result = 0;
    for (const part of parts) {
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 0 || num > 255) return null;
      result = (result << 8) | num;
    }

    return result >>> 0; // Convert to unsigned 32-bit
  }
}