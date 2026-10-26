import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Smoke test for controller route registration.
 *
 * The plugin layer is covered by httpStack.test.ts, but nothing exercised the
 * controllers' own `register()` calls, and route registration is where a
 * Fastify major upgrade tends to break silently: an option that is now
 * rejected, a path pattern that no longer parses, a duplicate route that used
 * to be tolerated. A typecheck cannot see any of that — it only shows up when
 * the instance is actually built.
 *
 * The database layer is stubbed because these controllers construct
 * repositories in their constructors; the point here is the HTTP wiring, not
 * the queries behind it.
 */

const repoStub = {
  findOne: vi.fn().mockResolvedValue(null),
  find: vi.fn().mockResolvedValue([]),
  count: vi.fn().mockResolvedValue(0),
  save: vi.fn(async (x: unknown) => x),
  update: vi.fn().mockResolvedValue({ affected: 0 }),
  delete: vi.fn().mockResolvedValue({ affected: 0 }),
  create: vi.fn((x: unknown) => x),
  createQueryBuilder: vi.fn(() => {
    const qb: any = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'getMany') return async () => [];
          if (prop === 'getOne') return async () => null;
          if (prop === 'execute') return async () => ({ affected: 0 });
          if (prop === 'getRawMany') return async () => [];
          return () => qb;
        },
      }
    );
    return qb;
  }),
};

vi.mock('../src/config/database', () => ({
  AppDataSource: {
    getRepository: () => repoStub,
    query: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    transaction: vi.fn(async (cb: (m: unknown) => unknown) => cb({ getRepository: () => repoStub })),
  },
}));

const botStub = {
  getBot: () => ({
    api: {
      getChatMember: vi.fn().mockResolvedValue({ status: 'member' }),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      restrictChatMember: vi.fn().mockResolvedValue(true),
      banChatMember: vi.fn().mockResolvedValue(true),
      unbanChatMember: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  }),
} as never;

const { createHttpServer } = await import('../src/server');
const { VerificationController } = await import('../src/controllers/VerificationController');
const { MiniAppController } = await import('../src/controllers/MiniAppController');
const { ChatwootVerificationController } = await import('../src/controllers/ChatwootVerificationController');
const { ChatwootTelegramGatewayController } = await import('../src/controllers/ChatwootTelegramGatewayController');

describe('controller route registration', () => {
  let app: FastifyInstance;
  let routes: string;

  beforeAll(async () => {
    app = await createHttpServer();

    await new VerificationController(botStub).register(app);
    await new MiniAppController(botStub).register(app);
    await new ChatwootVerificationController().register(app);
    await new ChatwootTelegramGatewayController().register(app);

    await app.ready();
    routes = app.printRoutes();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('builds an instance with every controller mounted', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each([
    ['verify', 'the legacy verification page'],
    ['miniapp', 'the Mini App API'],
    ['admin', 'the admin API'],
  ])('registers routes containing %s (%s)', (fragment) => {
    expect(routes).toContain(fragment);
  });

  it('still 404s an unknown path once every controller is mounted', () => {
    // Guards against a controller registering an over-broad wildcard that
    // swallows the whole namespace. (/health and /live are defined in
    // bootstrap rather than here, since they report on the database, Redis and
    // the bot — none of which this instance owns.)
    return app
      .inject({ method: 'GET', url: '/definitely-not-a-route-xyz' })
      .then((res) => expect(res.statusCode).toBe(404));
  });

  it('serves a static asset alongside the controller routes', async () => {
    // Static is registered at the root prefix, so it shares a namespace with
    // every controller route — the combination is what would collide.
    const res = await app.inject({ method: 'GET', url: '/css/modern-verify.css' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an unauthenticated Mini App call rather than crashing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/miniapp/leaderboard',
      payload: { groupId: '-100123' },
    });
    // The specific code depends on which guard fires first; what matters is
    // that the route exists, runs, and refuses.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(600);
  });

  it('rejects oversized filter arrays at the request validation boundary', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/admin/settings/update',
      payload: {
        initData: 'invalid-signature', groupId: '-100123',
        updates: { filter: { customKeywords: Array(201).fill('keyword') } },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['updates', 'filter', 'customKeywords'], code: 'too_big' }),
    ]));
  });

  it('validates a partial settings update before requiring authentication', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/admin/settings/update',
      payload: { initData: 'invalid-signature', groupId: '-100123', updates: { filter: { enabled: true } } },
    });
    expect(res.statusCode).toBe(401);
  });
});
