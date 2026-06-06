import { describe, it, expect } from 'vitest';
import { LevelService } from '../src/services/LevelService';

describe('LevelService.calculateLevel / xpForLevel', () => {
  it('is level 1 at 0 xp and level 2 at 100 xp', () => {
    expect(LevelService.calculateLevel(0)).toBe(1);
    expect(LevelService.calculateLevel(100)).toBe(2);
  });

  it('is monotonically non-decreasing in xp', () => {
    let prev = 0;
    for (let xp = 0; xp <= 100000; xp += 257) {
      const lv = LevelService.calculateLevel(xp);
      expect(lv).toBeGreaterThanOrEqual(prev);
      prev = lv;
    }
  });

  it('xpForLevel(lv) is enough to reach at least lv', () => {
    for (let lv = 1; lv <= 50; lv++) {
      expect(LevelService.calculateLevel(LevelService.xpForLevel(lv))).toBeGreaterThanOrEqual(lv);
    }
  });
});

describe('LevelService.getTitle', () => {
  it('returns default titles by level', () => {
    expect(LevelService.getTitle(1)).toContain('新手');
    expect(LevelService.getTitle(5)).toContain('活跃');
    expect(LevelService.getTitle(50)).toContain('神话');
  });

  it('picks the highest matching custom title regardless of input order', () => {
    const custom = [
      { minLevel: 1, title: 'A' },
      { minLevel: 10, title: 'B' },
      { minLevel: 5, title: 'C' },
    ];
    expect(LevelService.getTitle(12, custom)).toBe('B');
    expect(LevelService.getTitle(7, custom)).toBe('C');
    expect(LevelService.getTitle(3, custom)).toBe('A');
  });

  it('falls back to the base title when below all custom minLevels', () => {
    expect(LevelService.getTitle(1, [{ minLevel: 5, title: 'C' }])).toBe('🌱 新手');
  });

  it('uses defaults when custom titles is empty or null', () => {
    expect(LevelService.getTitle(50, [])).toContain('神话');
    expect(LevelService.getTitle(50, null)).toContain('神话');
  });
});
