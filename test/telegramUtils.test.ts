import { describe, expect, it, vi } from 'vitest';
import { kickUser } from '../src/utils/telegram';

function makeBot(overrides: Record<string, unknown> = {}) {
  const api = {
    banChatMember: vi.fn().mockResolvedValue(true),
    unbanChatMember: vi.fn().mockResolvedValue(true),
    ...overrides,
  };

  return { bot: { api } as any, api };
}

describe('kickUser rejoin recovery', () => {
  it('removes and immediately unbans when cooldown is disabled so verification can be retried', async () => {
    const { bot, api } = makeBot();

    await kickUser(bot, -1001, 42, 0);

    expect(api.banChatMember).toHaveBeenCalledWith(-1001, 42);
    expect(api.unbanChatMember).toHaveBeenCalledWith(-1001, 42, {
      only_if_banned: true,
    });
    expect(api.banChatMember.mock.invocationCallOrder[0]).toBeLessThan(
      api.unbanChatMember.mock.invocationCallOrder[0]
    );
  });

  it('propagates an unban failure so the scheduler can retry instead of leaving a permanent ban', async () => {
    const { bot } = makeBot({
      unbanChatMember: vi.fn().mockRejectedValue(new Error('Telegram unavailable')),
    });

    await expect(kickUser(bot, -1001, 42, 0)).rejects.toThrow('Telegram unavailable');
  });

  it('defaults to a 60-second temporary ban without an immediate unban', async () => {
    const { bot, api } = makeBot();
    const before = Math.floor(Date.now() / 1000);

    await kickUser(bot, -1001, 42);

    expect(api.banChatMember).toHaveBeenCalledWith(
      -1001,
      42,
      expect.objectContaining({ until_date: expect.any(Number) })
    );
    const options = api.banChatMember.mock.calls[0][2] as { until_date: number };
    expect(options.until_date).toBeGreaterThanOrEqual(before + 60);
    expect(api.unbanChatMember).not.toHaveBeenCalled();
  });

  it('clamps a short positive cooldown above Telegram\'s permanent-ban boundary', async () => {
    const { bot, api } = makeBot();
    const before = Math.floor(Date.now() / 1000);

    await kickUser(bot, -1001, 42, 1);

    const options = api.banChatMember.mock.calls[0][2] as { until_date: number };
    expect(options.until_date).toBeGreaterThanOrEqual(before + 35);
  });
});
