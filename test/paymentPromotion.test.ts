import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentFilterHandler } from '../src/handlers/ContentFilterHandler';
import { CONTENT_SCAN_SEPARATOR, ContentFilterService, HIGH_CONFIDENCE_SPAM_LABELS } from '../src/services/ContentFilterService';

const REPORTED_NAME = '蓝色天空虚拟卡源头';
const REPORTED_TEXT = 'Claude/GPT专用 Visa💳订阅 投流丝滑付';
const service = new ContentFilterService();
const filter = service.getFilterConfig({ filter: { enabled: true, newUserLinkDelay: 0 } });

describe('payment promotion without a link', () => {
  it.each([
    REPORTED_TEXT,
    'Claude/GPT 专用 Visa 订阅 投流丝滑付',
    'Claude/GPT专用 Visa💳订阅\n投流丝滑付',
    'Ｃｌａｕｄｅ／ＧＰＴ专用 Ｖｉｓａ💳订阅 投流丝滑付',
    'Clau\u200bde/GPT专用 Vi\u200dsa💳订阅 投流丝\u200b滑付',
    'Claude/GPT專用 Visa💳訂閱 投流絲滑付',
    '虚 拟 卡 一 手 货 源，支 持 GPT 订 阅',
    'GPT订阅虚拟卡批发，支持投流',
    'ChatGPT/Claude 低价代充，秒到账',
    'Claude 代付服务，特价订阅',
  ])('blocks a commercial pitch: %s', (text) => {
    const result = service.analyzeText(text, filter);
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('支付服务推广');
  });

  it.each([
    'Claude 和 GPT 哪个写代码好？',
    'Claude/GPT专用 Visa💳订阅',
    'Visa 能订阅 Claude 吗？',
    '我的 GPT 订阅用 Visa 支付失败了',
    '虚拟卡是什么，和信用卡有什么区别？',
    'Visa 的支付流程挺丝滑',
    'GPT 写代码丝滑，今天刚订阅',
    'GPT 订阅我用自己的 Visa 卡付成功了',
    'Claude 订阅不支持我这张虚拟卡吗？',
    'ChatGPT代充安全吗？',
    '不要找陌生人代付 Claude',
    '这个虚拟卡商靠谱吗？',
    '这个虚拟卡商支持 GPT 订阅吗？',
    'GPT 订阅我用 Visa 一手操作完成',
    '我用 Visa 订阅 GPT 一直稳定扣款',
    'Visa 可以稳定支付 Claude 订阅',
    '虚拟卡批发商提供的卡可以订阅 Claude 吗？',
    'USDT 转账今天稳定到账了',
  ])('allows ordinary discussion: %s', (text) => {
    expect(service.analyzeText(text, filter).blocked).toBe(false);
  });

  it('does not depend on link or phone rules', () => {
    expect(service.analyzeText(REPORTED_TEXT, {
      ...filter, blockUrls: false, blockInviteLinks: false, blockPhoneNumbers: false,
    }).blocked).toBe(true);
  });

  it('does not combine unrelated body and quote/keyboard/link fields', () => {
    const text = ['GPT订阅用 Visa', '一手货源'].join(CONTENT_SCAN_SEPARATOR);
    expect(service.analyzeText(text, filter).blocked).toBe(false);
  });

  it('keeps commercial heuristics out of degraded-mode decisive categories', () => {
    const result = service.analyzeText(REPORTED_TEXT, filter);
    expect(result.reasons.filter(reason => HIGH_CONFIDENCE_SPAM_LABELS.has(reason))).toEqual([]);
  });

  it.each(['USDT 投资稳赚', 'USDT 日赚 500', '出入金稳赚项目', '搬砖套利', '合约带单'])(
    'preserves actual crypto-scam detection: %s', (text) => {
      const result = service.analyzeText(text, filter);
      expect(result.blocked).toBe(true);
      expect(result.reasons).toContain('币圈诈骗');
    }
  );
});

function harness(text: string, name = REPORTED_NAME, username?: string) {
  const api = {
    deleteMessage: vi.fn().mockResolvedValue(true),
    restrictChatMember: vi.fn().mockResolvedValue(true),
    banChatMember: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const analyzer = new ContentFilterService();
  vi.spyOn(analyzer, 'addViolation').mockResolvedValue(1);
  const handler = new ContentFilterHandler({ api } as never, analyzer, audit as never);
  const ctx = {
    chat: { id: -1001234567890 },
    from: { id: 555, first_name: name, username, is_bot: false },
    message: { message_id: 42, text },
    api,
    deleteMessage: api.deleteMessage,
  };
  const settings = { customSettings: { filter } };
  const run = (isAdmin = false) => handler.handle(ctx as never, settings as never, isAdmin);
  return { ctx, settings, api, audit, run };
}

describe('payment promotion through the moderation handler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('deletes the reported message and records the reason', async () => {
    const h = harness(REPORTED_TEXT);
    expect(await h.run()).toBe(true);
    expect(h.api.deleteMessage).toHaveBeenCalledOnce();
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'message_filtered',
      metadata: expect.objectContaining({ reasons: ['支付服务推广'], messageDeleted: true }),
    }));
    expect(h.api.banChatMember).not.toHaveBeenCalled();
  });

  it('uses a seller nickname to corroborate a terse product pitch', async () => {
    const h = harness('Claude/GPT专用 Visa💳订阅');
    expect(await h.run()).toBe(true);
    expect(h.api.deleteMessage).toHaveBeenCalledOnce();
  });

  it('uses both parts of a display name', async () => {
    const h = harness('Claude/GPT专用 Visa💳订阅', '蓝色天空');
    Object.assign(h.ctx.from, { last_name: '虚拟卡源头' });
    expect(await h.run()).toBe(true);
  });

  it('normalizes the seller nickname too', async () => {
    const h = harness('Claude/GPT专用 Visa💳订阅', '虛擬卡源頭');
    expect(await h.run()).toBe(true);
  });

  it.each(['VCC4989', 'vcc8296', 'Vcc_visa', 'vccShop'])(
    'uses a VCC-prefixed username with a product pitch: %s', async (username) => {
      const h = harness('Claude/GPT专用 Visa💳订阅', '蓝色天空', username);
      expect(await h.run()).toBe(true);
      expect(h.api.deleteMessage).toHaveBeenCalledOnce();
      expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ reasons: ['支付服务推广'] }),
      }));
    }
  );

  it('combines the VCC username with a payment pitch that omits the card brand', async () => {
    const h = harness('Claude/GPT订阅 投流丝滑付', '蓝色天空', 'VCC4989');
    expect(await h.run()).toBe(true);
    expect(h.api.deleteMessage).toHaveBeenCalledOnce();
  });

  it('still needs card evidence for a pitch without a card brand', async () => {
    const h = harness('Claude/GPT订阅 投流丝滑付', '蓝色天空', 'normal_user');
    expect(await h.run()).toBe(false);
  });

  it.each(['nvcc_user', 'dev_vcc', 'myvcc4989', 'normal_user'])(
    'does not treat an unrelated username as a VCC seller: %s', async (username) => {
      const h = harness('Claude/GPT专用 Visa💳订阅', '蓝色天空', username);
      expect(await h.run()).toBe(false);
      expect(h.api.deleteMessage).not.toHaveBeenCalled();
    }
  );

  it.each([
    '',
    '大家早上好',
    'Visa 能订阅 Claude 吗？',
    '我的 GPT 订阅用 Visa 支付失败了',
    'GPT 写代码很好用',
    'Claude/GPT专用提示词分享',
    'VCC 是电源引脚，怎么接线？',
  ])('requires a payment pitch even with both seller identity signals: %s', async (text) => {
    const h = harness(text, REPORTED_NAME, 'VCC4989');
    expect(await h.run()).toBe(false);
    expect(h.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not borrow a replied-to sender username', async () => {
    const h = harness('Claude/GPT专用 Visa💳订阅', '蓝色天空');
    Object.assign(h.ctx.message, {
      reply_to_message: { from: { id: 999, first_name: REPORTED_NAME, username: 'VCC4989' } },
    });
    expect(await h.run()).toBe(false);
  });

  it('does not feed usernames into generic keyword rules', async () => {
    const h = harness('大家早上好', '蓝色天空', 'vcc4989');
    h.settings.customSettings.filter = { ...filter, customKeywords: ['vcc'] };
    expect(await h.run()).toBe(false);
  });

  it.each([
    '大家早上好',
    'Visa 能订阅 Claude 吗？',
    '我的 GPT 订阅用 Visa 支付失败了',
    'GPT 写代码很好用',
  ])('does not punish a nickname on its own: %s', async (text) => {
    const h = harness(text);
    expect(await h.run()).toBe(false);
    expect(h.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not feed nicknames into generic keyword/link/phone rules', async () => {
    const h = harness('大家早上好', 'https://example.com 13812345678 赌博');
    expect(await h.run()).toBe(false);
    expect(h.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not treat an ordinary nickname as a card seller', async () => {
    const h = harness('Claude/GPT专用 Visa💳订阅', '蓝色天空');
    expect(await h.run()).toBe(false);
  });

  it('also filters media captions', async () => {
    const h = harness('');
    Object.assign(h.ctx.message, { caption: REPORTED_TEXT });
    expect(await h.run()).toBe(true);
  });

  it('honors the configured punishment', async () => {
    const h = harness(REPORTED_TEXT);
    h.settings.customSettings.filter = { ...filter, action: 'mute' };
    expect(await h.run()).toBe(true);
    expect(h.api.restrictChatMember).toHaveBeenCalledWith(
      h.ctx.chat.id, h.ctx.from.id, expect.any(Object), expect.any(Object)
    );
  });

  it('respects disabled filtering', async () => {
    const h = harness(REPORTED_TEXT);
    h.settings.customSettings.filter = { ...filter, enabled: false };
    expect(await h.run()).toBe(false);
    expect(h.api.deleteMessage).not.toHaveBeenCalled();
  });

  it('preserves the administrator exemption', async () => {
    const h = harness(REPORTED_TEXT);
    expect(await h.run(true)).toBe(false);
    expect(h.api.deleteMessage).not.toHaveBeenCalled();
  });
});
