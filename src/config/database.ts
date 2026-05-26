import { DataSource } from 'typeorm';
import { config } from './config';
import { User } from '../entities/User';
import { Group } from '../entities/Group';
import { GroupSettings } from '../entities/GroupSettings';
import { JoinSession } from '../entities/JoinSession';
import { AuditLog } from '../entities/AuditLog';
import { Whitelist } from '../entities/Whitelist';
import { Blacklist } from '../entities/Blacklist';
import { UserGroupProfile } from '../entities/UserGroupProfile';
import { Lottery } from '../entities/Lottery';
import { ChatwootVerificationSession } from '../entities/ChatwootVerificationSession';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: config.db.host,
  port: config.db.port,
  username: config.db.username,
  password: config.db.password,
  database: config.db.database,
  synchronize: false,
  logging: config.env === 'development',
  entities: [
    User,
    Group,
    GroupSettings,
    JoinSession,
    AuditLog,
    Whitelist,
    Blacklist,
    UserGroupProfile,
    Lottery,
    ChatwootVerificationSession,
  ],
  migrations: ['dist/migrations/*.js'],
  subscribers: [],
});
