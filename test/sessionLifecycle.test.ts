import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the join-session state machine.
 *
 * The defect these pin down is the one that let automated accounts stay in a
 * group indefinitely: verifySession() used to write `status = 'expired'` when a
 * session was opened after its deadline. That write is reachable by the account
 * being policed — it only has to click its own verification link late — and the
 * cleanup job claims work with `status IN ('pending','removal_pending')`, so
 * self-expiring removed the row from the removal queue permanently. Enforcement
 * transitions must belong to the scheduler alone.
 */

const repos = new Map<string, any>();

function makeQueryBuilder(executeResult: { affected?: number } = { affected: 1 }) {
  const captured: any = { set: undefined, wheres: [] as string[], params: {} as Record<string, unknown> };
  const qb: any = {
    captured,
    update: vi.fn(() => qb),
    set: vi.fn((v: unknown) => {
      captured.set = v;
      return qb;
    }),
    where: vi.fn((clause: string, params?: Record<string, unknown>) => {
      captured.wheres.push(clause);
      Object.assign(captured.params, params || {});
      return qb;
    }),
    andWhere: vi.fn((clause: string, params?: Record<string, unknown>) => {
      captured.wheres.push(clause);
      Object.assign(captured.params, params || {});
      return qb;
    }),
    execute: vi.fn(async () => executeResult),
  };
  return qb;
}

function makeRepo() {
  return {
    findOne: vi.fn(),
    save: vi.fn(async (x: unknown) => x),
    update: vi.fn(async () => ({ affected: 1 })),
    count: vi.fn(async () => 0),
    delete: vi.fn(async () => ({ affected: 0 })),
    create: vi.fn((x: unknown) => x),
    createQueryBuilder: vi.fn(() => makeQueryBuilder()),
  };
}

vi.mock('../src/config/database', () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => {
      const key = entity?.name ?? String(entity);
      if (!repos.has(key)) repos.set(key, makeRepo());
      return repos.get(key);
    },
  },
}));

const { VerificationService } = await import('../src/services/VerificationService');

function sessionRepo() {
  return repos.get('JoinSession');
}

describe('verifySession', () => {
  let service: InstanceType<typeof VerificationService>;

  beforeEach(() => {
    repos.clear();
    service = new VerificationService();
  });

  it('does not persist any status change when the session has already expired', async () => {
    const repo = sessionRepo();
    repo.findOne.mockResolvedValue({
      id: 's1',
      userId: '10',
      groupId: '-100',
      status: 'pending',
      expiresAt: new Date(Date.now() - 60_000),
    });

    const ok = await service.verifySession('s1');

    expect(ok).toBe(false);
    // The whole point: no write of any kind. A persisted 'expired' here would
    // take the row out of the scheduler's claim query forever.
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('leaves an expired session in a state the scheduler can still claim', async () => {
    const repo = sessionRepo();
    const row = {
      id: 's1',
      userId: '10',
      groupId: '-100',
      status: 'pending',
      expiresAt: new Date(Date.now() - 60_000),
    };
    repo.findOne.mockResolvedValue(row);

    await service.verifySession('s1');

    expect(row.status).toBe('pending');
  });

  it('verifies a live session with a conditional update', async () => {
    const repo = sessionRepo();
    repo.findOne.mockResolvedValue({
      id: 's1',
      userId: '10',
      groupId: '-100',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const qb = makeQueryBuilder({ affected: 1 });
    repo.createQueryBuilder.mockReturnValue(qb);

    const ok = await service.verifySession('s1', '1.2.3.4', 'agent');

    expect(ok).toBe(true);
    expect(qb.captured.set).toMatchObject({ status: 'verified', userIp: '1.2.3.4', userAgent: 'agent' });

    // The guard clauses are what make concurrent submissions safe.
    const clauses = qb.captured.wheres.join(' ');
    expect(clauses).toContain('status = :status');
    expect(clauses).toContain('expiresAt');
    expect(qb.captured.params.status).toBe('pending');
  });

  it('reports failure when a concurrent request already claimed the session', async () => {
    const repo = sessionRepo();
    repo.findOne.mockResolvedValue({
      id: 's1',
      userId: '10',
      groupId: '-100',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    });
    // affected = 0 means another request won the race.
    repo.createQueryBuilder.mockReturnValue(makeQueryBuilder({ affected: 0 }));

    const ok = await service.verifySession('s1');

    expect(ok).toBe(false);
  });

  it('refuses sessions that are not pending', async () => {
    const repo = sessionRepo();
    for (const status of ['verified', 'expired', 'cancelled', 'removed', 'removal_pending']) {
      repo.findOne.mockResolvedValue({
        id: 's1',
        userId: '10',
        groupId: '-100',
        status,
        expiresAt: new Date(Date.now() + 60_000),
      });

      expect(await service.verifySession('s1')).toBe(false);
    }
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('refuses an unknown session id', async () => {
    sessionRepo().findOne.mockResolvedValue(null);
    expect(await service.verifySession('nope')).toBe(false);
  });
});

describe('markRestrictionApplied', () => {
  beforeEach(() => {
    repos.clear();
  });

  it('records whether the join-time mute actually took effect', async () => {
    const service = new VerificationService();
    await service.markRestrictionApplied('s1', true);

    expect(sessionRepo().update).toHaveBeenCalledWith({ id: 's1' }, { restrictionApplied: true });
  });
});
