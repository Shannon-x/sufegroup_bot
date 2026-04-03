import crypto from 'crypto';
import { Repository, LessThan } from 'typeorm';
import { AppDataSource } from '../config/database';
import { UserGroupProfile } from '../entities/UserGroupProfile';
import { Lottery } from '../entities/Lottery';
import { Logger } from '../utils/logger';
import { redisService } from './RedisService';

// ── Default titles ──

const DEFAULT_TITLES: Array<{ minLevel: number; title: string }> = [
  { minLevel: 50, title: '👑 神话' },
  { minLevel: 30, title: '💎 传说' },
  { minLevel: 20, title: '🏆 元老' },
  { minLevel: 10, title: '⭐ 达人' },
  { minLevel: 5,  title: '🌟 活跃' },
  { minLevel: 1,  title: '🌱 新手' },
];

// ── Checkin rewards ──

const CHECKIN_BASE_COINS = 10;
const CHECKIN_STREAK_BONUS = 2;
const CHECKIN_STREAK_MAX_BONUS = 50;
const CHECKIN_7DAY_BONUS = 50;
const CHECKIN_30DAY_BONUS = 200;
const CHECKIN_XP = 15;

// ── XP config ──

const XP_PER_MESSAGE_MIN = 1;
const XP_PER_MESSAGE_MAX = 3;
const XP_COOLDOWN_SECONDS = 30;

// ── Cache TTL ──

export class LevelService {
  private profileRepo: Repository<UserGroupProfile>;
  private lotteryRepo: Repository<Lottery>;
  private logger: Logger;

  constructor() {
    this.profileRepo = AppDataSource.getRepository(UserGroupProfile);
    this.lotteryRepo = AppDataSource.getRepository(Lottery);
    this.logger = new Logger('LevelService');
  }

  // ── Profile ──

  async getOrCreateProfile(userId: string, groupId: string): Promise<UserGroupProfile> {
    let profile = await this.profileRepo.findOne({ where: { userId, groupId } });
    if (!profile) {
      profile = this.profileRepo.create({ userId, groupId });
      await this.profileRepo.save(profile);
    }
    return profile;
  }

  // ── XP & Level ──

  static calculateLevel(xp: number): number {
    return Math.floor(Math.sqrt(xp / 100)) + 1;
  }

  static xpForLevel(level: number): number {
    return (level - 1) * (level - 1) * 100;
  }

  /**
   * Get title for a level, using custom titles if available.
   */
  static getTitle(level: number, customTitles?: Array<{ minLevel: number; title: string }> | null): string {
    const titles = customTitles && customTitles.length > 0
      ? [...customTitles].sort((a, b) => b.minLevel - a.minLevel)
      : DEFAULT_TITLES;
    for (const t of titles) {
      if (level >= t.minLevel) return t.title;
    }
    return '🌱 新手';
  }

  /**
   * Get default titles (for display in settings).
   */
  static getDefaultTitles(): Array<{ minLevel: number; title: string }> {
    return DEFAULT_TITLES;
  }

  /**
   * Award XP for a message. Batches XP in Redis, flushes on level-up check.
   */
  async awardMessageXP(
    userId: string,
    groupId: string,
    customTitles?: Array<{ minLevel: number; title: string }> | null
  ): Promise<{ leveledUp: boolean; newLevel: number; title: string } | null> {
    const cdKey = `xp_cd:${groupId}:${userId}`;
    const onCooldown = await redisService.exists(cdKey);
    if (onCooldown) return null;

    await redisService.set(cdKey, '1', XP_COOLDOWN_SECONDS);

    const xpGain = XP_PER_MESSAGE_MIN + Math.floor(Math.random() * (XP_PER_MESSAGE_MAX - XP_PER_MESSAGE_MIN + 1));

    // Accumulate XP in Redis, flush to DB periodically
    const xpKey = `xp_buf:${groupId}:${userId}`;
    const msgKey = `msg_buf:${groupId}:${userId}`;
    const bufferedXP = await redisService.increment(xpKey, 600);
    await redisService.increment(msgKey, 600);

    // Flush to DB every 10 XP accumulated or on first message
    if (bufferedXP >= 10 || bufferedXP === xpGain) {
      return this.flushXPBuffer(userId, groupId, customTitles);
    }

    return null;
  }

  /**
   * Flush accumulated XP from Redis to database.
   */
  async flushXPBuffer(
    userId: string,
    groupId: string,
    customTitles?: Array<{ minLevel: number; title: string }> | null
  ): Promise<{ leveledUp: boolean; newLevel: number; title: string } | null> {
    const xpKey = `xp_buf:${groupId}:${userId}`;
    const msgKey = `msg_buf:${groupId}:${userId}`;

    const xpStr = await redisService.get(xpKey);
    const msgStr = await redisService.get(msgKey);
    const xpToAdd = xpStr ? parseInt(xpStr, 10) : 0;
    const msgsToAdd = msgStr ? parseInt(msgStr, 10) : 0;

    if (xpToAdd <= 0) return null;

    // Clear buffer
    await redisService.delete(xpKey);
    await redisService.delete(msgKey);

    const profile = await this.getOrCreateProfile(userId, groupId);
    const oldLevel = profile.level;

    profile.xp += xpToAdd;
    profile.totalMessages += msgsToAdd;
    profile.level = LevelService.calculateLevel(profile.xp);

    await this.profileRepo.save(profile);

    if (profile.level > oldLevel) {
      return {
        leveledUp: true,
        newLevel: profile.level,
        title: LevelService.getTitle(profile.level, customTitles),
      };
    }
    return null;
  }

  // ── Checkin ──

  async checkin(userId: string, groupId: string): Promise<{
    success: boolean;
    alreadyChecked?: boolean;
    coins: number;
    streak: number;
    bonusCoins: number;
    xp: number;
    totalCoins: number;
  }> {
    const profile = await this.getOrCreateProfile(userId, groupId);
    const today = this.getTodayStr();

    if (profile.lastCheckinDate === today) {
      return { success: false, alreadyChecked: true, coins: 0, streak: profile.checkinStreak, bonusCoins: 0, xp: 0, totalCoins: profile.coins };
    }

    const yesterday = this.getDateStr(-1);
    profile.checkinStreak = profile.lastCheckinDate === yesterday ? profile.checkinStreak + 1 : 1;
    profile.lastCheckinDate = today;

    let coins = CHECKIN_BASE_COINS;
    let bonusCoins = 0;

    const streakBonus = Math.min(profile.checkinStreak * CHECKIN_STREAK_BONUS, CHECKIN_STREAK_MAX_BONUS);
    coins += streakBonus;

    if (profile.checkinStreak === 7) bonusCoins += CHECKIN_7DAY_BONUS;
    if (profile.checkinStreak > 0 && profile.checkinStreak % 30 === 0) bonusCoins += CHECKIN_30DAY_BONUS;

    profile.coins += coins + bonusCoins;
    profile.xp += CHECKIN_XP;
    profile.level = LevelService.calculateLevel(profile.xp);

    await this.profileRepo.save(profile);

    return {
      success: true,
      coins,
      streak: profile.checkinStreak,
      bonusCoins,
      xp: CHECKIN_XP,
      totalCoins: profile.coins,
    };
  }

  // ── Leaderboard ──

  async getLeaderboard(groupId: string, limit: number = 10): Promise<UserGroupProfile[]> {
    return this.profileRepo.find({
      where: { groupId },
      order: { xp: 'DESC' },
      take: limit,
    });
  }

  async getCoinsLeaderboard(groupId: string, limit: number = 10): Promise<UserGroupProfile[]> {
    return this.profileRepo.find({
      where: { groupId },
      order: { coins: 'DESC' },
      take: limit,
    });
  }

  async getRank(userId: string, groupId: string): Promise<number> {
    const profile = await this.profileRepo.findOne({ where: { userId, groupId } });
    if (!profile) return 0;

    const count = await this.profileRepo
      .createQueryBuilder('p')
      .where('p."groupId" = :groupId AND p.xp > :xp', { groupId, xp: profile.xp })
      .getCount();

    return count + 1;
  }

  async getCoinsRank(userId: string, groupId: string): Promise<number> {
    const profile = await this.profileRepo.findOne({ where: { userId, groupId } });
    if (!profile) return 0;

    const count = await this.profileRepo
      .createQueryBuilder('p')
      .where('p."groupId" = :groupId AND p.coins > :coins', { groupId, coins: profile.coins })
      .getCount();

    return count + 1;
  }

  // ── Coins ──

  async addCoins(userId: string, groupId: string, amount: number): Promise<number> {
    const profile = await this.getOrCreateProfile(userId, groupId);
    profile.coins += amount;
    await this.profileRepo.save(profile);
    return profile.coins;
  }

  async deductCoins(userId: string, groupId: string, amount: number): Promise<boolean> {
    const profile = await this.getOrCreateProfile(userId, groupId);
    if (profile.coins < amount) return false;
    profile.coins -= amount;
    await this.profileRepo.save(profile);
    return true;
  }

  // ── Lottery ──

  async createLottery(groupId: string, createdBy: string, prize: string, winnerCount: number, durationMinutes: number, minLevel: number, costCoins: number): Promise<Lottery> {
    const endsAt = new Date(Date.now() + durationMinutes * 60 * 1000);
    const lottery = this.lotteryRepo.create({ groupId, createdBy, prize, winnerCount, minLevel, costCoins, endsAt, participants: [], status: 'active' });
    await this.lotteryRepo.save(lottery);
    return lottery;
  }

  async getActiveLotteries(groupId: string): Promise<Lottery[]> {
    return this.lotteryRepo.find({ where: { groupId, status: 'active' }, order: { createdAt: 'DESC' } });
  }

  async getLottery(id: number): Promise<Lottery | null> {
    return this.lotteryRepo.findOne({ where: { id } });
  }

  async saveLottery(lottery: Lottery): Promise<void> {
    await this.lotteryRepo.save(lottery);
  }

  async joinLottery(lotteryId: number, userId: string, groupId: string): Promise<{ success: true } | { success: false; reason: string }> {
    const lottery = await this.getLottery(lotteryId);
    if (!lottery || lottery.status !== 'active') return { success: false, reason: '抽奖不存在或已结束' };
    if (lottery.groupId !== groupId) return { success: false, reason: '抽奖不属于本群' };
    if (new Date() > lottery.endsAt) return { success: false, reason: '抽奖已过期' };
    if (lottery.participants.includes(userId)) return { success: false, reason: '您已参与过' };

    if (lottery.minLevel > 0) {
      const profile = await this.getOrCreateProfile(userId, groupId);
      if (profile.level < lottery.minLevel) return { success: false, reason: `需要等级 ${lottery.minLevel}，您当前等级 ${profile.level}` };
    }
    if (lottery.costCoins > 0) {
      if (!await this.deductCoins(userId, groupId, lottery.costCoins)) return { success: false, reason: `需要 ${lottery.costCoins} 积分，余额不足` };
    }

    lottery.participants.push(userId);
    await this.lotteryRepo.save(lottery);
    return { success: true };
  }

  async drawLottery(lotteryId: number): Promise<{ success: boolean; winners?: string[]; lottery?: Lottery; reason?: string }> {
    const lottery = await this.getLottery(lotteryId);
    if (!lottery || lottery.status !== 'active') return { success: false, reason: '抽奖不存在或已结束' };
    if (lottery.participants.length === 0) {
      lottery.status = 'cancelled';
      await this.lotteryRepo.save(lottery);
      return { success: false, reason: '无人参与，抽奖已取消' };
    }

    const shuffled = [...lottery.participants];
    // Fisher-Yates shuffle with cryptographically secure randomness
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const winners = shuffled.slice(0, Math.min(lottery.winnerCount, shuffled.length));

    lottery.winners = winners;
    lottery.status = 'drawn';
    await this.lotteryRepo.save(lottery);
    return { success: true, winners, lottery };
  }

  async cancelLottery(lotteryId: number, userId: string): Promise<{ success: boolean; reason?: string }> {
    const lottery = await this.getLottery(lotteryId);
    if (!lottery || lottery.status !== 'active') return { success: false, reason: '抽奖不存在或已结束' };
    if (lottery.createdBy !== userId) return { success: false, reason: '只有创建者可以取消' };

    if (lottery.costCoins > 0) {
      for (const pid of lottery.participants) await this.addCoins(pid, lottery.groupId, lottery.costCoins);
    }
    lottery.status = 'cancelled';
    await this.lotteryRepo.save(lottery);
    return { success: true };
  }

  async processExpiredLotteries(): Promise<Lottery[]> {
    const expired = await this.lotteryRepo.find({ where: { status: 'active', endsAt: LessThan(new Date()) } });
    const drawn: Lottery[] = [];
    for (const lottery of expired) {
      const result = await this.drawLottery(lottery.id);
      if (result.success && result.lottery) drawn.push(result.lottery);
    }
    return drawn;
  }

  // ── Utils ──

  private getTodayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private getDateStr(offsetDays: number): string {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  }
}
