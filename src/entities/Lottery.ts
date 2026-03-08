import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

export type LotteryStatus = 'active' | 'drawn' | 'cancelled';

@Entity('lotteries')
export class Lottery {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint')
  groupId: string;

  @Column('bigint')
  createdBy: string;

  @Column({ type: 'varchar', length: 500 })
  prize: string;

  @Column({ type: 'int', default: 1 })
  winnerCount: number;

  @Column({ type: 'int', default: 0 })
  minLevel: number;

  @Column({ type: 'int', default: 0 })
  costCoins: number;

  @Column({ type: 'jsonb', default: '[]' })
  participants: string[];

  @Column({ type: 'jsonb', nullable: true })
  winners: string[] | null;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: LotteryStatus;

  @Column({ type: 'timestamp' })
  endsAt: Date;

  @Column({ type: 'int', nullable: true })
  messageId: number | null;

  @CreateDateColumn()
  createdAt: Date;
}
