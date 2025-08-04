import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToOne, JoinColumn } from 'typeorm';
import { Group } from './Group';

export type AutoAction = 'mute' | 'kick';

@Entity('group_settings')
export class GroupSettings {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint', { unique: true })
  groupId: string;

  @Column({ type: 'boolean', default: true })
  verificationEnabled: boolean;

  @Column({ type: 'int', default: 10 })
  ttlMinutes: number;

  @Column({ type: 'enum', enum: ['mute', 'kick'], default: 'mute' })
  autoAction: AutoAction;

  @Column({ type: 'text', default: '新成员【{user_name}】 你好！\n小菲欢迎您加入{group_name}群\n您当前需要完成验证才能解除限制，验证有效时间不超过{ttl} 秒。\n过期会被踢出或封禁，请尽快。' })
  welcomeTemplate: string;

  @Column({ type: 'boolean', default: true })
  deleteJoinMessage: boolean;

  @Column({ type: 'boolean', default: true })
  deleteWelcomeMessage: boolean;

  @Column({ type: 'int', default: 300 }) // 5 minutes
  deleteWelcomeMessageAfter: number;

  @Column({ type: 'int', default: 10 })
  rateLimitPerMinute: number;

  @Column({ type: 'boolean', default: false })
  adminBypassVerification: boolean;

  @Column({ type: 'jsonb', nullable: true })
  customSettings: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToOne(() => Group, group => group.settings)
  @JoinColumn({ name: 'groupId' })
  group: Group;
}