import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { JoinSession } from './JoinSession';
import { AuditLog } from './AuditLog';
import { Whitelist } from './Whitelist';
import { Blacklist } from './Blacklist';

@Entity('users')
export class User {
  @PrimaryColumn('bigint')
  id: string; // Telegram user ID

  @Column({ type: 'varchar', length: 255, nullable: true })
  username?: string;

  @Column({ type: 'varchar', length: 255 })
  firstName: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  lastName?: string;

  @Column({ type: 'boolean', default: false })
  isBot: boolean;

  @Column({ type: 'varchar', length: 10, nullable: true })
  languageCode?: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => JoinSession, session => session.user)
  joinSessions: JoinSession[];

  @OneToMany(() => AuditLog, log => log.user)
  auditLogs: AuditLog[];

  @OneToMany(() => Whitelist, whitelist => whitelist.user)
  whitelists: Whitelist[];

  @OneToMany(() => Blacklist, blacklist => blacklist.user)
  blacklists: Blacklist[];
}