import { Repository } from 'typeorm';
import { AppDataSource } from '../config/database';
import { Group } from '../entities/Group';
import { GroupSettings } from '../entities/GroupSettings';
import { Logger } from '../utils/logger';
import { redisService } from './RedisService';
import { Chat } from 'grammy/types';

const SETTINGS_CACHE_TTL = 300; // 5 minutes
const ADMIN_CACHE_TTL = 120;    // 2 minutes

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
      if ('title' in chat && group.title !== chat.title) { group.title = chat.title; updated = true; }
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
    const cached = await redisService.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as GroupSettings;
      } catch {
        // Corrupted cache, fall through to DB
      }
    }

    const settings = await this.settingsRepository.findOne({ where: { groupId } });
    if (settings) {
      await redisService.set(cacheKey, JSON.stringify(settings), SETTINGS_CACHE_TTL);
    }
    return settings;
  }

  /**
   * Invalidate settings cache after updates.
   */
  async invalidateSettingsCache(groupId: string): Promise<void> {
    await redisService.delete(`gs:${groupId}`);
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
  async isAdminCached(chatId: number, userId: number, botApi: any): Promise<boolean> {
    const cacheKey = `admin:${chatId}:${userId}`;
    const cached = await redisService.get(cacheKey);
    if (cached !== null) return cached === '1';

    try {
      const member = await botApi.getChatMember(chatId, userId);
      const isAdmin = member.status === 'administrator' || member.status === 'creator';
      await redisService.set(cacheKey, isAdmin ? '1' : '0', ADMIN_CACHE_TTL);
      return isAdmin;
    } catch {
      return false;
    }
  }

  /**
   * Get all groups where a user is admin (for Mini App).
   */
  async getAdminGroups(userId: string, botApi: any): Promise<Group[]> {
    const groups = await this.groupRepository.find({ where: { isActive: true }, relations: ['settings'] });
    const adminGroups: Group[] = [];

    for (const group of groups) {
      try {
        const isAdmin = await this.isAdminCached(Number(group.id), Number(userId), botApi);
        if (isAdmin) adminGroups.push(group);
      } catch {
        // Skip groups where we can't check
      }
    }
    return adminGroups;
  }
}
