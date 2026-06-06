import { Repository, In } from 'typeorm';
import { AppDataSource } from '../config/database';
import { User } from '../entities/User';
import { Logger } from '../utils/logger';
import { User as TelegramUser } from 'grammy/types';

export class UserService {
  private userRepository: Repository<User>;
  private logger: Logger;

  constructor() {
    this.userRepository = AppDataSource.getRepository(User);
    this.logger = new Logger('UserService');
  }

  async findOrCreate(telegramUser: TelegramUser): Promise<User> {
    const userId = telegramUser.id.toString();
    
    let user = await this.userRepository.findOne({
      where: { id: userId }
    });

    if (!user) {
      user = this.userRepository.create({
        id: userId,
        username: telegramUser.username,
        firstName: telegramUser.first_name,
        lastName: telegramUser.last_name,
        isBot: telegramUser.is_bot || false,
        languageCode: telegramUser.language_code,
      });
      
      await this.userRepository.save(user);
      this.logger.info(`Created new user: ${userId}`);
    } else {
      // Update user info if changed
      let updated = false;
      
      if (user.username !== telegramUser.username) {
        user.username = telegramUser.username;
        updated = true;
      }
      
      if (user.firstName !== telegramUser.first_name) {
        user.firstName = telegramUser.first_name;
        updated = true;
      }
      
      if (user.lastName !== telegramUser.last_name) {
        user.lastName = telegramUser.last_name;
        updated = true;
      }
      
      if (updated) {
        await this.userRepository.save(user);
        this.logger.info(`Updated user info: ${userId}`);
      }
    }

    return user;
  }

  async findById(userId: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { id: userId }
    });
  }

  /**
   * Batch-fetch users by id. Returns a Map keyed by user id so callers can
   * avoid N+1 queries (e.g. leaderboard rendering).
   */
  async findByIds(userIds: string[]): Promise<Map<string, User>> {
    const unique = [...new Set(userIds)].filter(Boolean);
    if (unique.length === 0) return new Map();
    const users = await this.userRepository.find({ where: { id: In(unique) } });
    return new Map(users.map((u) => [u.id, u]));
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { username }
    });
  }
}