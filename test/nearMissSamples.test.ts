import { describe, it, expect } from 'vitest';
import { ContentFilterService } from '../src/services/ContentFilterService';

/**
 * Regression cases taken from the production `near_miss` log (Sept–Nov 2026):
 * messages the filter scored but let through.
 *
 * Two problems showed up there, in opposite directions:
 *  - A bot-farm funnel ("/start 18 @ihrm7rbot\n@lnhgtx8pm2bot\n…") was posted
 *    dozens of times by three accounts and scored zero every time.
 *  - "频道推广" was the most frequent reason of all, and every hit was an
 *    ordinary question. The pattern was written as character classes, so a
 *    single 加/进/入 followed by any of c/h/a/n/e/l counted as promotion.
 */

const svc = new ContentFilterService();
const THIS_BOT = 'sufeadmin_bot';

function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    blockUrls: true,
    blockInviteLinks: true,
    blockPhoneNumbers: true,
    blockForwards: false,
    blockBotMentions: false,
    customKeywords: [],
    whitelistUrls: [],
    newUserLinkDelay: 0,
    flood: { enabled: false },
    ...overrides,
  } as any;
}

function verdict(text: string) {
  return svc.analyzeText(text, config(), { exemptBots: [THIS_BOT] });
}

describe('bot-farm /start funnels', () => {
  // Verbatim samples, three different senders.
  it.each([
    '/start 18 @ihrm7rbot\n@lnhgtx8pm2bot\n@gb781748ff6b3bot',
    '/start 265 @mjju54hxbot\n@suy4ybot\n@e8tqs4xebot',
    '/start 1 @nr5irbot\n@bwdkugbot\n@esmlcbot',
    '/start 433 @egol9kbot\n@pc6ep6ibot\n@kx5pobot',
    '/start 82 @x1jvgbot\n@g5zp4i4bot\n@p2c4k8ibot',
  ])('blocks %j', (text) => {
    const result = verdict(text);
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('钓鱼机器人');
  });

  it('blocks the shape with a single bot and the payload in front', () => {
    expect(verdict('/start ref_8812 @somefreshbot').blocked).toBe(true);
  });

  it('blocks a bare rotation list of bots even without /start', () => {
    expect(verdict('@ihrm7rbot\n@lnhgtx8pm2bot\n@gb781748ff6b3bot').blocked).toBe(true);
  });

  it('survives full-width obfuscation of the command', () => {
    expect(verdict('／ｓｔａｒｔ 18 @ihrm7rbot\n@lnhgtx8pm2bot').blocked).toBe(true);
  });
});

describe('ordinary bot mentions stay allowed', () => {
  it.each([
    // Verbatim from the log.
    '@sufe_pro_bot',
    '@sufe_pro_bot @sufeadmin_bot verizon也掉了',
    '@sufeadmin_bot @sufe_pro_bot',
    // Addressing a command to a bot: no space, no payload.
    '/start@sufe_pro_bot',
    '/help@sufe_pro_bot',
    // Naming several bots inside an actual sentence.
    '@gif_bot @vote_bot @like_bot 这几个哪个比较好用？有人试过吗',
  ])('allows %j', (text) => {
    const result = verdict(text);
    expect(result.blocked).toBe(false);
    expect(result.reasons).not.toContain('钓鱼机器人');
  });
});

describe('频道推广 no longer fires on ordinary chat', () => {
  // Every one of these was logged as a "频道推广" near miss.
  it.each([
    '请教一下群里的佬们，我刚开了30块钱美国静态加宽的套餐，google，youtube，telegram倒是可以打开，为啥chatgpt和claude，ping0，这几个网站打不开呀。',
    'muse注册不了，前两天gemini也用不了，我claude一直用的这个节点，我不想换节点啊，我怕跳ip被封号',
    '美国加州verzion  都快送中一个礼拜了，还没处理',
    '不同的运营商的套餐，有啥区别啊……加州Verizon、加州ATT、TMobile，好几个不同的，似乎价格和量也都差不多。',
    '感觉是上下文太长了，websocket在返回前就关闭了，好像是oai的问题？',
    '想问一下入了美国家宽的车，是还有单独的群要入吗？',
    '关了之后又恢复正常了，但是AI延迟还是依旧很大',
    '其他的关于T-mobile的用不了了啊',
    '又进icu了',
    '加油啊 用ai的人需要推荐网络我都是推的你们',
    'claude注册充值也没有kyc',
    '是啊 关键是Claude 用的就是outlook  天崩了',
    '好像备用的att加宽的hy2协议一直都是死的',
    '凭购买记录入群😁',
  ])('%j', (text) => {
    const result = verdict(text);
    expect(result.reasons).not.toContain('频道推广');
    expect(result.score).toBe(0);
  });

  it.each([
    '欢迎关注我们的频道',
    '快来加入我们的群组',
    '进群领福利',
    '频道每天推荐优质资源',
  ])('still scores real channel promotion: %j', (text) => {
    expect(verdict(text).reasons).toContain('频道推广');
  });
});

describe('虚假广告 needs whole words', () => {
  it('does not pair unrelated characters', () => {
    expect(verdict('今天太阳很大，这个产品不错').reasons).not.toContain('虚假广告');
  });

  it('still catches the pitch', () => {
    expect(verdict('纯天然减肥胶囊，一周瘦十斤').reasons).toContain('虚假广告');
  });
});
