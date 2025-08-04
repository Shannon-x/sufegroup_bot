import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { User } from './User';
import { Group } from './Group';

export type AuditAction = 
  | 'user_joined'
  | 'user_left'
  | 'user_verified'
  | 'user_failed_verification'
  | 'user_kicked'
  | 'user_banned'
  | 'user_unbanned'
  | 'user_muted'
  | 'user_unmuted'
  | 'whitelist_added'
  | 'whitelist_removed'
  | 'blacklist_added'
  | 'blacklist_removed'
  | 'settings_changed'
  | 'command_executed'
  | 'reverify_triggered'
  | 'bot_added';

@Entity('audit_logs')
@Index(['groupId', 'createdAt'])
@Index(['userId', 'createdAt'])
@Index(['action', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint')
  groupId: string;

  @Column('bigint', { nullable: true })
  userId?: string; // Target user

  @Column('bigint', { nullable: true })
  performedBy?: string; // Admin who performed the action

  @Column({ type: 'varchar', length: 50 })
  action: AuditAction;

  @Column({ type: 'text', nullable: true })
  details?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip?: string;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => User, user => user.auditLogs, { nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @ManyToOne(() => Group, group => group.auditLogs)
  @JoinColumn({ name: 'groupId' })
  group: Group;
}