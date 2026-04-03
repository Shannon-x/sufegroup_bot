import { config } from '../config/config';
import { Logger } from '../utils/logger';

export interface HCaptchaVerifyResponse {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
}

export class HCaptchaService {
  private logger: Logger;
  private secretKey: string | undefined;
  private verifyUrl = 'https://api.hcaptcha.com/siteverify';

  constructor() {
    this.logger = new Logger('HCaptchaService');
    this.secretKey = config.hcaptcha.secretKey;
  }

  isConfigured(): boolean {
    return !!(config.hcaptcha.siteKey && config.hcaptcha.secretKey);
  }

  getSiteKey(): string | undefined {
    return config.hcaptcha.siteKey;
  }

  async verify(token: string, remoteIp?: string): Promise<HCaptchaVerifyResponse> {
    if (!this.isConfigured()) {
      this.logger.error('HCaptcha is not configured but verify was called');
      return { success: false, 'error-codes': ['not-configured'] };
    }

    try {
      const formData = new URLSearchParams();
      formData.append('secret', this.secretKey as string);
      formData.append('response', token);
      
      if (remoteIp) {
        // Not strictly required for hCaptcha, but supported
        // formData.append('remoteip', remoteIp);
      }

      const response = await fetch(this.verifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      const result = await response.json() as HCaptchaVerifyResponse;

      if (!result.success) {
        this.logger.warn('hCaptcha verification failed', {
          errorCodes: result['error-codes'],
          remoteIp
        });
      }

      return result;
    } catch (error) {
      this.logger.error('Error verifying hCaptcha token', error);
      return {
        success: false,
        'error-codes': ['internal-error']
      };
    }
  }
}
