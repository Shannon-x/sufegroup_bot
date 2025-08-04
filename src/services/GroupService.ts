import { Repository } from 'typeorm';
import { AppDataSource } from '../config/database';
import { Group } from '../entities/Group';
import { GroupSettings } from '../entities/GroupSettings';
import { Logger } from '../utils/logger';
import { Chat } from 'grammy/types';

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
      // Create new group
      group = this.groupRepository.create({
        id: groupId,
        title: 'title' in chat ? chat.title : 'Unknown',
        username: 'username' in chat ? chat.username : undefined,
        type: chat.type,
      });
      
      await this.groupRepository.save(group);
      
      // Create default settings
      const settings = this.settingsRepository.create({
        groupId: groupId,
      });
      
      await this.settingsRepository.save(settings);
      group.settings = settings;
      
      this.logger.info(`Created new group: ${groupId}`);
    } else {
      // Update group info if changed
      let updated = false;
      
      if ('title' in chat && group.title !== chat.title) {
        group.title = chat.title;
        updated = true;
      }
      
      if ('username' in chat && group.username !== chat.username) {
        group.username = chat.username;
        updated = true;
      }
      
      if (updated) {
        await this.groupRepository.save(group);
        this.logger.info(`Updated group info: ${groupId}`);
      }
      
      // Ensure settings exist
      if (!group.settings) {
        const settings = this.settingsRepository.create({
          groupId: groupId,
        });
        
        await this.settingsRepository.save(settings);
        group.settings = settings;
      }
    }

    return { group, settings: group.settings };
  }

  async getSettings(groupId: string): Promise<GroupSettings | null> {
    return this.settingsRepository.findOne({
      where: { groupId }
    });
  }

  async findById(groupId: string): Promise<Group | null> {
    return this.groupRepository.findOne({
      where: { id: groupId },
      relations: ['settings']
    });
  }

  async updateSettings(groupId: string, updates: Partial<GroupSettings>): Promise<GroupSettings> {
    const settings = await this.getSettings(groupId);
    
    if (!settings) {
      throw new Error('Group settings not found');
    }

    Object.assign(settings, updates);
    await this.settingsRepository.save(settings);
    
    this.logger.info(`Updated settings for group ${groupId}`, { updates });
    
    return settings;
  }

  async setActive(groupId: string, isActive: boolean): Promise<void> {
    await this.groupRepository.update({ id: groupId }, { isActive });
    this.logger.info(`Set group ${groupId} active status to ${isActive}`);
  }
}