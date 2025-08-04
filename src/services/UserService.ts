import { Repository } from 'typeorm';
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

  async findByUsername(username: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { username }
    });
  }
}