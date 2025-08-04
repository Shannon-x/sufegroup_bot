import { config } from '../config/config';
import { Logger } from '../utils/logger';

export interface TurnstileVerifyResponse {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
}

export class TurnstileService {
  private logger: Logger;
  private secretKey: string;
  private verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

  constructor() {
    this.logger = new Logger('TurnstileService');
    this.secretKey = config.turnstile.secretKey;
  }

  async verify(token: string, remoteIp?: string): Promise<TurnstileVerifyResponse> {
    try {
      const formData = new URLSearchParams();
      formData.append('secret', this.secretKey);
      formData.append('response', token);
      
      if (remoteIp) {
        formData.append('remoteip', remoteIp);
      }

      const response = await fetch(this.verifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      const result = await response.json() as TurnstileVerifyResponse;

      if (!result.success) {
        this.logger.warn('Turnstile verification failed', {
          errorCodes: result['error-codes'],
          remoteIp
        });
      }

      return result;
    } catch (error) {
      this.logger.error('Error verifying Turnstile token', error);
      return {
        success: false,
        'error-codes': ['internal-error']
      };
    }
  }

  getSiteKey(): string {
    return config.turnstile.siteKey;
  }
}