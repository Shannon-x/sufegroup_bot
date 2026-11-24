import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * audit_logs.userId has a foreign key to users.id. Filtered messages from users
 * the bot had never registered failed that constraint, so their audit rows were
 * dropped. AuditService.log must make sure the users row exists first.
 */

const calls: string[] = [];
const userInserts: Record<string, unknown>[] = [];
const auditSaves: Record<string, unknown>[] = [];
let orIgnoreUsed = false;

vi.mock('../src/config/database', () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => {
      if (entity.name === 'User') {
        return {
          createQueryBuilder: () => {
            const qb: any = {
              insert: () => qb,
              into: () => qb,
              values: (v: Record<string, unknown>) => { userInserts.push(v); return qb; },
              orIgnore: () => { orIgnoreUsed = true; return qb; },
              execute: async () => { calls.push('user'); return {}; },
            };
            return qb;
          },
        };
      }
      return {
        create: (v: Record<string, unknown>) => v,
        save: async (v: Record<string, unknown>) => { calls.push('audit'); auditSaves.push(v); return v; },
      };
    },
  },
}));

import { AuditService } from '../src/services/AuditService';

describe('AuditService.log user row', () => {
  beforeEach(() => {
    calls.length = 0;
    userInserts.length = 0;
    auditSaves.length = 0;
    orIgnoreUsed = false;
  });

  it('creates the target user (idempotently) before writing the audit row', async () => {
    await new AuditService().log({
      groupId: '-100',
      userId: '42',
      action: 'message_filtered',
      userProfile: { firstName: 'Spammer', username: 'spam' },
    });
    expect(calls).toEqual(['user', 'audit']);
    expect(orIgnoreUsed).toBe(true);
    expect(userInserts[0]).toMatchObject({ id: '42', firstName: 'Spammer', username: 'spam' });
    expect(auditSaves[0]).not.toHaveProperty('userProfile');
  });

  it('falls back to the id when no name is known', async () => {
    await new AuditService().log({ groupId: '-100', userId: '7', action: 'user_kicked' });
    expect(userInserts[0]).toMatchObject({ id: '7', firstName: '7' });
  });

  it('does not touch users when there is no target user', async () => {
    await new AuditService().log({ groupId: '-100', action: 'settings_changed' });
    expect(calls).toEqual(['audit']);
  });
});
