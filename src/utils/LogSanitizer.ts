export class LogSanitizer {
  private static readonly SENSITIVE_FIELDS = new Set([
    'text',
    'caption',
    'messagetext',
    'message_text',
    'first_name',
    'last_name',
    'firstname',
    'lastname',
    'username',
    'phone_number',
    'email',
    'contact',
    'location',
    'venue'
  ]);

  static sanitize(data: any): any {
    if (!data || typeof data !== 'object') {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map(item => this.sanitize(item));
    }

    const sanitized: any = {};

    for (const [key, value] of Object.entries(data)) {
      if (this.SENSITIVE_FIELDS.has(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object') {
        sanitized[key] = this.sanitize(value);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  static sanitizeWebhookUpdate(update: any): any {
    return {
      update_id: update.update_id,
      type: this.getUpdateType(update),
      chat_id: update.message?.chat?.id || update.callback_query?.message?.chat?.id,
      user_id: update.message?.from?.id || update.callback_query?.from?.id || update.chat_member?.from?.id,
      has_text: !!update.message?.text,
      new_members_count: update.message?.new_chat_members?.length || 0,
      timestamp: new Date().toISOString()
    };
  }

  private static getUpdateType(update: any): string {
    if (update.message) return 'message';
    if (update.callback_query) return 'callback_query';
    if (update.chat_member) return 'chat_member';
    if (update.inline_query) return 'inline_query';
    if (update.chat_join_request) return 'chat_join_request';
    return 'unknown';
  }
}