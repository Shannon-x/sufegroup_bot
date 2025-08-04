import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { User } from './User';
import { Group } from './Group';

@Entity('whitelists')
@Unique(['groupId', 'userId'])
export class Whitelist {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('bigint')
  groupId: string;

  @Column('bigint')
  userId: string;

  @Column('bigint')
  addedBy: string;

  @Column({ type: 'text', nullable: true })
  reason?: string;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => User, user => user.whitelists)
  @JoinColumn({ name: 'userId' })
  user: User;

  @ManyToOne(() => Group, group => group.whitelists)
  @JoinColumn({ name: 'groupId' })
  group: Group;
}