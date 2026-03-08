import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index, Unique } from 'typeorm';

@Entity('user_group_profiles')
@Unique(['userId', 'groupId'])
@Index(['groupId', 'xp'])
export class UserGroupProfile {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint')
  userId: string;

  @Column('bigint')
  groupId: string;

  @Column({ type: 'int', default: 0 })
  xp: number;

  @Column({ type: 'int', default: 1 })
  level: number;

  @Column({ type: 'int', default: 0 })
  totalMessages: number;

  @Column({ type: 'int', default: 0 })
  coins: number;

  @Column({ type: 'int', default: 0 })
  checkinStreak: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  lastCheckinDate: string | null; // YYYY-MM-DD

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
