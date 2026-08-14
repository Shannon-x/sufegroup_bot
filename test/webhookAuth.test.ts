import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The webhook endpoint is the bot's only inbound trust boundary. These tests
 * pin the property that matters: an update is processed only when it carries
 * the configured secret. The previous implementation compared the incoming
 * header to the configured secret with a helper that treated
 * `undefined === undefined` as a match, so a deployment that had never set
 * BOT_WEBHOOK_SECRET accepted unauthenticated updates from anyone who knew the
 * URL — a full bot takeover via forged updates.
 */

// Mirrors the shape the modules under test (and their logger import) read.
const mockConfig = {
  env: 'test',
  bot: { webhookSecret: undefined as string | undefined, webhookDomain: 'example.com' },
  logging: { level: 'error', filePath: './logs/test.log' },
};

vi.mock('../src/config/config', () => ({ config: mockConfig }));

const { WebhookSignatureVerifier } = await import('../src/middleware/WebhookSignatureVerifier');

function makeReply() {
  const reply: any = {
    statusCode: 200,
    payload: undefined,
    code(c: number) {
      reply.statusCode = c;
      return reply;
    },
    send(p: unknown) {
      reply.payload = p;
      return reply;
    },
  };
  return reply;
}

function makeRequest(headers: Record<string, string> = {}, body: unknown = { update_id: 1 }) {
  return { headers, body } as any;
}

describe('WebhookSignatureVerifier', () => {
  beforeEach(() => {
    mockConfig.bot.webhookSecret = undefined;
  });

  it('rejects every request when no secret is configured', async () => {
    const reply = makeReply();
    const ok = await WebhookSignatureVerifier.verify(makeRequest(), reply);

    expect(ok).toBe(false);
    expect(reply.statusCode).toBe(404);
  });

  it('rejects a request that supplies a secret when none is configured', async () => {
    const reply = makeReply();
    const ok = await WebhookSignatureVerifier.verify(
      makeRequest({ 'x-telegram-bot-api-secret-token': 'anything' }),
      reply
    );

    expect(ok).toBe(false);
  });

  it('rejects a request with no secret header when one is configured', async () => {
    mockConfig.bot.webhookSecret = 'correct-horse-battery-staple';
    const reply = makeReply();

    const ok = await WebhookSignatureVerifier.verify(makeRequest(), reply);

    expect(ok).toBe(false);
    expect(reply.statusCode).toBe(404);
  });

  it('rejects a wrong secret', async () => {
    mockConfig.bot.webhookSecret = 'correct-horse-battery-staple';
    const reply = makeReply();

    const ok = await WebhookSignatureVerifier.verify(
      makeRequest({ 'x-telegram-bot-api-secret-token': 'wrong-secret-same-len!!!!!!!' }),
      reply
    );

    expect(ok).toBe(false);
  });

  it('accepts the configured secret', async () => {
    mockConfig.bot.webhookSecret = 'correct-horse-battery-staple';
    const reply = makeReply();

    const ok = await WebhookSignatureVerifier.verify(
      makeRequest({ 'x-telegram-bot-api-secret-token': 'correct-horse-battery-staple' }),
      reply
    );

    expect(ok).toBe(true);
  });

  it('rejects a tampered HMAC signature when one is supplied', async () => {
    mockConfig.bot.webhookSecret = 'correct-horse-battery-staple';
    const reply = makeReply();

    const ok = await WebhookSignatureVerifier.verify(
      makeRequest({
        'x-telegram-bot-api-secret-token': 'correct-horse-battery-staple',
        'x-telegram-bot-api-signature': 'sha256=deadbeef',
      }),
      reply
    );

    expect(ok).toBe(false);
  });

  it('accepts a correct HMAC signature', async () => {
    mockConfig.bot.webhookSecret = 'correct-horse-battery-staple';
    const body = { update_id: 42 };
    const signature = WebhookSignatureVerifier.generateSignature(JSON.stringify(body));
    const reply = makeReply();

    const ok = await WebhookSignatureVerifier.verify(
      makeRequest(
        {
          'x-telegram-bot-api-secret-token': 'correct-horse-battery-staple',
          'x-telegram-bot-api-signature': signature,
        },
        body
      ),
      reply
    );

    expect(ok).toBe(true);
  });
});
