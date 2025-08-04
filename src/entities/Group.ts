import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, OneToOne, OneToMany } from 'typeorm';
import { GroupSettings } from './GroupSettings';
import { JoinSession } from './JoinSession';
import { AuditLog } from './AuditLog';
import { Whitelist } from './Whitelist';
import { Blacklist } from './Blacklist';

@Entity('groups')
export class Group {
  @PrimaryColumn('bigint')
  id: string; // Telegram group ID

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  username?: string;

  @Column({ type: 'varchar', length: 50 })
  type: string; // 'group' | 'supergroup' | 'channel'

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToOne(() => GroupSettings, settings => settings.group)
  settings: GroupSettings;

  @OneToMany(() => JoinSession, session => session.group)
  joinSessions: JoinSession[];

  @OneToMany(() => AuditLog, log => log.group)
  auditLogs: AuditLog[];

  @OneToMany(() => Whitelist, whitelist => whitelist.group)
  whitelists: Whitelist[];

  @OneToMany(() => Blacklist, blacklist => blacklist.group)
  blacklists: Blacklist[];
}