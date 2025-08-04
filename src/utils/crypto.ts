import crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { config } from '../config/config';

export class CryptoUtils {
  static generateToken(payload: any, expiresIn: string = '1h'): string {
    return jwt.sign(payload, config.security.jwtSecret, { expiresIn: expiresIn as any });
  }

  static verifyToken(token: string): any {
    try {
      return jwt.verify(token, config.security.jwtSecret);
    } catch {
      return null;
    }
  }

  static generateHmac(data: string): string {
    return crypto
      .createHmac('sha256', config.security.hmacSecret)
      .update(data)
      .digest('hex');
  }

  static verifyHmac(data: string, signature: string): boolean {
    const expected = this.generateHmac(data);
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  }

  static generateVerificationToken(userId: string, groupId: string, sessionId: string): string {
    const payload = {
      userId,
      groupId,
      sessionId,
      exp: Math.floor(Date.now() / 1000) + (config.defaults.verifyTtlMinutes * 60),
    };
    
    const token = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = this.generateHmac(token);
    
    return `${token}.${signature}`;
  }

  static verifyVerificationToken(token: string): { userId: string; groupId: string; sessionId: string } | null {
    try {
      const [data, signature] = token.split('.');
      
      if (!this.verifyHmac(data, signature)) {
        return null;
      }
      
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
      
      if (payload.exp < Math.floor(Date.now() / 1000)) {
        return null;
      }
      
      return {
        userId: payload.userId,
        groupId: payload.groupId,
        sessionId: payload.sessionId,
      };
    } catch {
      return null;
    }
  }
}