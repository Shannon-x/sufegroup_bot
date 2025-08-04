import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { User } from './User';
import { Group } from './Group';

export type SessionStatus = 'pending' | 'verified' | 'expired' | 'failed' | 'cancelled';

@Entity('join_sessions')
@Index(['groupId', 'userId', 'status'])
@Index(['expiresAt'])
export class JoinSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('bigint')
  userId: string;

  @Column('bigint')
  groupId: string;

  @Column({ type: 'enum', enum: ['pending', 'verified', 'expired', 'failed', 'cancelled'], default: 'pending' })
  status: SessionStatus;

  @Column({ type: 'int' })
  messageId: number; // Welcome message ID

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  verifiedAt?: Date;

  @Column({ type: 'varchar', length: 45, nullable: true })
  userIp?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent?: string;

  @Column({ type: 'int', default: 0 })
  attemptCount: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @ManyToOne(() => User, user => user.joinSessions)
  @JoinColumn({ name: 'userId' })
  user: User;

  @ManyToOne(() => Group, group => group.joinSessions)
  @JoinColumn({ name: 'groupId' })
  group: Group;
}