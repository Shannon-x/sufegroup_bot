import { Repository } from 'typeorm';
import { AppDataSource } from '../config/database';
import { Group } from '../entities/Group';
import { GroupSettings } from '../entities/GroupSettings';
import { Logger } from '../utils/logger';
import { redisService } from './RedisService';
import { Chat } from 'grammy/types';

const SETTINGS_CACHE_TTL = 300; // 5 minutes
const ADMIN_CACHE_TTL = 60;     // 1 minute (shorter so demotions take effect sooner)

export class GroupService {
  private groupRepository: Repository<Group>;
  private settingsRepository: Repository<GroupSettings>;
  private logger: Logger;

  constructor() {
    this.groupRepository = AppDataSource.getRepository(Group);
    this.settingsRepository = AppDataSource.getRepository(GroupSettings);
    this.logger = new Logger('GroupService');
  }

  async findOrCreate(chat: Chat): Promise<{ group: Group; settings: GroupSettings }> {
    const groupId = chat.id.toString();

    let group = await this.groupRepository.findOne({
      where: { id: groupId },
      relations: ['settings']
    });

    if (!group) {
      group = this.groupRepository.create({
        id: groupId,
        title: 'title' in chat ? chat.title : 'Unknown',
        username: 'username' in chat ? chat.username : undefined,
        type: chat.type,
      });
      await this.groupRepository.save(group);

      const settings = this.settingsRepository.create({ groupId });
      await this.settingsRepository.save(settings);
      group.settings = settings;
      this.logger.info(`Created new group: ${groupId}`);
    } else {
      let updated = false;
      if ('title' in chat && chat.title && group.title !== chat.title) { group.title = chat.title; updated = true; }
      if ('username' in chat && group.username !== chat.username) { group.username = chat.username; updated = true; }
      if (updated) {
        await this.groupRepository.save(group);
      }
      if (!group.settings) {
        const settings = this.settingsRepository.create({ groupId });
        await this.settingsRepository.save(settings);
        group.settings = settings;
      }
    }

    return { group, settings: group.settings };
  }

  /**
   * Get settings with Redis cache (avoids DB hit on every message).
   */
  async getSettings(groupId: string): Promise<GroupSettings | null> {
    const cacheKey = `gs:${groupId}`;

    // Redis is a cache here, not a source of truth, so a Redis outage must not
    // propagate. Previously both calls below were unguarded: a Redis-only
    // failure threw out of getSettings even though Postgres was perfectly
    // healthy, which took down the whole moderation pipeline and pushed every
    // group into degraded handling. Postgres remains the authority.
    try {
      const cached = await redisService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as GroupSettings;
      }
    } catch (error) {
      this.logger.warn('Settings cache read failed, falling back to database', error);
    }

    const settings = await this.settingsRepository.findOne({ where: { groupId } });
    if (settings) {
      try {
        await redisService.set(cacheKey, JSON.stringify(settings), SETTINGS_CACHE_TTL);
      } catch (error) {
        this.logger.warn('Settings cache write failed, continuing uncached', error);
      }
    }
    return settings;
  }

  /**
   * Invalidate settings cache after updates.
   */
  async invalidateSettingsCache(groupId: string): Promise<void> {
    // Same reasoning as getSettings: a cache eviction failure must not fail the
    // settings write that triggered it. The entry expires on its own TTL.
    try {
      await redisService.delete(`gs:${groupId}`);
    } catch (error) {
      this.logger.warn('Settings cache invalidation failed; entry will expire on TTL', error);
    }
  }

  async findById(groupId: string): Promise<Group | null> {
    return this.groupRepository.findOne({
      where: { id: groupId },
      relations: ['settings']
    });
  }

  async updateSettings(groupId: string, updates: Partial<GroupSettings>): Promise<GroupSettings> {
    const settings = await this.settingsRepository.findOne({ where: { groupId } });
    if (!settings) throw new Error('Group settings not found');

    Object.assign(settings, updates);
    await this.settingsRepository.save(settings);
    await this.invalidateSettingsCache(groupId);

    this.logger.info(`Updated settings for group ${groupId}`);
    return settings;
  }

  async setActive(groupId: string, isActive: boolean): Promise<void> {
    await this.groupRepository.update({ id: groupId }, { isActive });
  }

  // ── Admin status cache ──

  /**
   * Check if user is admin with Redis cache to avoid Telegram API calls on every message.
   */
  async isAdminCached(chatId: number, userId: number, botApi: any, bypassCache = false): Promise<boolean> {
    const cacheKey = `admin:${chatId}:${userId}`;
    if (!bypassCache) {
      try {
        const cached = await redisService.get(cacheKey);
        if (cached !== null) return cached === '1';
      } catch (error) {
        // Cache miss by another name — fall through to the live API check.
        this.logger.debug('Admin cache read failed, querying Telegram', error);
      }
    }

    try {
      const member = await botApi.getChatMember(chatId, userId);
      const isAdmin = member.status === 'administrator' || member.status === 'creator';
      try {
        await redisService.set(cacheKey, isAdmin ? '1' : '0', ADMIN_CACHE_TTL);
      } catch {
        // Uncached is fine; the next call just pays for another API round-trip.
      }
      return isAdmin;
    } catch {
      return false;
    }
  }

  /**
   * Get groups where a specific user is an admin (for Mini App).
   * Checks are run in parallel with a per-group timeout to avoid slow serial API calls.
   */
  async getAdminGroups(userId: string, botApi: any): Promise<Group[]> {
    const groups = await this.groupRepository.find({ where: { isActive: true }, relations: ['settings'] });

    // Wrap each check with a 3-second timeout so a single unresponsive group can't stall the whole list
    const withTimeout = (promise: Promise<boolean>, ms: number): Promise<boolean> =>
      Promise.race([
        promise,
        new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
      ]);

    const checks = await Promise.allSettled(
      groups.map(async (group) => {
        const isAdmin = await withTimeout(
          this.isAdminCached(Number(group.id), Number(userId), botApi),
          3000,
        );
        return isAdmin ? group : null;
      }),
    );

    return checks
      .filter((r): r is PromiseFulfilledResult<Group | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((g): g is Group => g !== null);
  }
}
