import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export type ChatwootVerificationStatus = 'pending' | 'verified' | 'expired' | 'failed';

@Entity('chatwoot_verification_sessions')
@Index(['inboxId', 'userId', 'status'])
@Index(['inboxId', 'userId', 'verifiedUntil'])
export class ChatwootVerificationSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 128 })
  inboxId: string;

  @Column('bigint')
  userId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  username?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  firstName?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  lastName?: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: ChatwootVerificationStatus;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  verifiedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  verifiedUntil?: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastPromptAt?: Date;

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
}
