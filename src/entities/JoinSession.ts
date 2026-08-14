import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { User } from './User';
import { Group } from './Group';

/**
 * Session lifecycle.
 *
 * `removal_pending` and `removed` split what used to be a single `expired`
 * write. The old code marked a session `expired` *before* attempting the kick,
 * so a failed kick left an unrestricted user in the group with a terminal
 * session row that nothing would ever retry — and the group was told the user
 * had been removed. `removal_pending` is the claim (taken atomically, so two
 * scheduler instances can't both act), and only a genuinely successful removal
 * advances to `removed`.
 *
 * `expired` remains the terminal state for the `mute` policy, where the correct
 * outcome is to leave the user restricted rather than remove them.
 */
export type SessionStatus =
  | 'pending'
  | 'verified'
  | 'expired'
  | 'failed'
  | 'cancelled'
  | 'removal_pending'
  | 'removed';

export const SESSION_STATUSES: SessionStatus[] = [
  'pending',
  'verified',
  'expired',
  'failed',
  'cancelled',
  'removal_pending',
  'removed',
];

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

  @Column({ type: 'enum', enum: SESSION_STATUSES, default: 'pending' })
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

  /** Failed removal attempts, used to bound retries before escalating to admins. */
  @Column({ type: 'int', default: 0 })
  removalAttempts: number;

  /** Last removal failure, surfaced to admins so permission drift is diagnosable. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  lastError?: string;

  /**
   * Set when the Telegram restriction call actually succeeded. A session whose
   * restrictions never applied must not be treated as "user is safely muted".
   */
  @Column({ type: 'boolean', default: false })
  restrictionApplied: boolean;

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