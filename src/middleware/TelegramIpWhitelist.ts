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
    // Use Fastify's resolved request.ip, which honours the configured
    // `trustProxy` setting. Reading X-Forwarded-For directly (as this used to)
    // trusts a header the client controls: behind a proxy that forwards rather
    // than overwrites it, anyone could prepend a Telegram IP and satisfy this
    // check. TRUST_PROXY decides how many hops are believed.
    const remoteIp = this.normalizeIp(request.ip);

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

  /**
   * Strip the IPv4-mapped IPv6 prefix Node reports on dual-stack sockets
   * (`::ffff:149.154.167.51`), which would otherwise fail the dotted-quad parse
   * and reject legitimate Telegram traffic.
   */
  private static normalizeIp(ip: string | undefined): string | undefined {
    if (!ip) return undefined;
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
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