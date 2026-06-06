import { describe, it, expect } from 'vitest';
import { ContentFilterService, DEFAULT_FILTER_CONFIG, type FilterConfig } from '../src/services/ContentFilterService';

const svc = new ContentFilterService();

describe('ContentFilterService.getFilterConfig (settings merge)', () => {
  it('returns defaults when there are no custom settings', () => {
    const c = svc.getFilterConfig(null);
    expect(c.enabled).toBe(false);
    expect(c.flood.maxMessages).toBe(10);
  });

  it('merges a stored filter over the defaults', () => {
    const c = svc.getFilterConfig({ filter: { enabled: true, action: 'ban' } });
    expect(c.enabled).toBe(true);
    expect(c.action).toBe('ban');
    expect(c.blockInviteLinks).toBe(true); // default preserved
  });

  it('deep-merges flood without losing default flood keys', () => {
    const c = svc.getFilterConfig({ filter: { flood: { enabled: true } } });
    expect(c.flood.enabled).toBe(true);
    expect(c.flood.windowSeconds).toBe(10); // default preserved
  });

  it('lets an empty keyword array clear keywords', () => {
    const c = svc.getFilterConfig({ filter: { customKeywords: [] } });
    expect(c.customKeywords).toEqual([]);
  });
});

describe('ContentFilterService.determineAction (escalation)', () => {
  const cfg: FilterConfig = { ...DEFAULT_FILTER_CONFIG, action: 'warn', maxWarnings: 3 };

  it('escalates warn → mute → ban', () => {
    expect(svc.determineAction(1, cfg)).toBe('warn');
    expect(svc.determineAction(3, cfg)).toBe('mute');
    expect(svc.determineAction(6, cfg)).toBe('ban');
  });

  it('always bans in ban mode', () => {
    expect(svc.determineAction(1, { ...cfg, action: 'ban' })).toBe('ban');
  });

  it('escalates to ban past 2x maxWarnings even in mute mode', () => {
    expect(svc.determineAction(2, { ...cfg, action: 'mute' })).toBe('mute');
    expect(svc.determineAction(6, { ...cfg, action: 'mute' })).toBe('ban');
  });
});

describe('ContentFilterService.analyzeText', () => {
  const cfg: FilterConfig = { ...DEFAULT_FILTER_CONFIG, enabled: true };

  it('passes clean text', () => {
    expect(svc.analyzeText('大家好，今天天气不错', cfg).blocked).toBe(false);
  });

  it('blocks gambling spam', () => {
    expect(svc.analyzeText('百家乐澳门赌场欢迎您', cfg).blocked).toBe(true);
  });

  it('blocks a custom keyword match', () => {
    const r = svc.analyzeText('这是内部消息', { ...cfg, customKeywords: ['内部消息'] });
    expect(r.blocked).toBe(true);
  });

  it('does nothing when the filter is disabled', () => {
    expect(svc.analyzeText('百家乐澳门赌场', { ...cfg, enabled: false }).blocked).toBe(false);
  });
});
