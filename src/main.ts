import 'reflect-metadata';
import { createHttpServer } from './server';
import { AppDataSource } from './config/database';
import { config } from './config/config';
import { Logger } from './utils/logger';
import { TelegramBot } from './services/TelegramBot';
import { VerificationController } from './controllers/VerificationController';
import { MiniAppController } from './controllers/MiniAppController';
import { ChatwootVerificationController } from './controllers/ChatwootVerificationController';
import { ChatwootTelegramGatewayController } from './controllers/ChatwootTelegramGatewayController';
import { SchedulerService } from './services/SchedulerService';
import { RateLimitMiddleware } from './middleware/RateLimitMiddleware';
import { TelegramIpWhitelist } from './middleware/TelegramIpWhitelist';
import { WebhookSignatureVerifier } from './middleware/WebhookSignatureVerifier';
import { LogSanitizer } from './utils/LogSanitizer';
import { redisService } from './services/RedisService';

const DB_CONNECT_ATTEMPTS = 10;
const DB_CONNECT_BASE_DELAY_MS = 1000;

async function connectWithRetry(logger: Logger): Promise<void> {
  for (let attempt = 1; attempt <= DB_CONNECT_ATTEMPTS; attempt++) {
    try {
      await AppDataSource.initialize();
      return;
    } catch (error) {
      if (attempt === DB_CONNECT_ATTEMPTS) throw error;
      const delay = Math.min(DB_CONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), 15000);
      logger.warn(
        `Database connection attempt ${attempt}/${DB_CONNECT_ATTEMPTS} failed, retrying in ${delay}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function bootstrap() {
  const logger = new Logger('Main');

  // Flipped once the bot is polling/receiving updates. Readiness reports false
  // until then so an orchestrator never routes traffic to a half-started bot.
  let botStarted = false;

  // M-11: warn (don't fail) when HMAC_SECRET isn't set independently — it falls
  // back to JWT_SECRET, which still works but is weaker isolation in production.
  if (!process.env.HMAC_SECRET) {
    logger.warn('HMAC_SECRET 未单独设置，已回退使用 JWT_SECRET；生产环境建议配置独立的 HMAC_SECRET。');
  }

  try {
    // Initialize database. Retried with backoff because an orchestrator commonly
    // starts the app before Postgres finishes accepting connections; a single
    // attempt turned that race into a crash loop.
    logger.info('Connecting to database...');
    await connectWithRetry(logger);
    logger.info('Database connected');

    // A misresolved migrations glob makes runMigrations() a silent no-op, which
    // leaves the app talking to an unmigrated schema. Catch it here instead.
    if (AppDataSource.migrations.length === 0) {
      throw new Error(
        'No migrations were discovered. Check the migrations glob in src/config/database.ts ' +
          'and that the project has been built.'
      );
    }

    // Run migrations automatically on startup.
    //
    // This is deliberately fatal. runMigrations() is idempotent — TypeORM skips
    // migrations already recorded in the `migrations` table — so a failure here
    // never means "already applied", it means the schema is genuinely broken.
    // Starting anyway produced the worst possible failure mode: a container that
    // reports healthy and a bot that appears online while every join-guard write
    // (sessions, restrictions, audit) silently errors out.
    logger.info('Running database migrations...');
    await AppDataSource.runMigrations();
    logger.info('Database migrations completed successfully');

    // HTTP stack lives in server.ts so its plugin configuration is testable
    // without a database, Redis or a Telegram connection.
    const fastify = await createHttpServer();

    // Initialize bot
    logger.info('Initializing Telegram bot...');
    const bot = new TelegramBot();

    // Initialize controllers
    const verificationController = new VerificationController(bot);
    await verificationController.register(fastify);

    const miniAppController = new MiniAppController(bot);
    await miniAppController.register(fastify);

    const chatwootVerificationController = new ChatwootVerificationController();
    await chatwootVerificationController.register(fastify);

    const chatwootTelegramGatewayController = new ChatwootTelegramGatewayController();
    await chatwootTelegramGatewayController.register(fastify);

    // Setup webhook endpoint if configured
    if (config.bot.webhookDomain) {
      const rateLimiter = new RateLimitMiddleware();
      
      fastify.post('/telegram-webhook', {
        preHandler: async (request, reply) => {
          // Verify IP whitelist
          const ipValid = await TelegramIpWhitelist.verify(request, reply);
          if (!ipValid) {
            return;
          }

          // Verify webhook signature and secret
          const signatureValid = await WebhookSignatureVerifier.verify(request, reply);
          if (!signatureValid) {
            return;
          }

          // Rate limit webhooks
          return rateLimiter.checkRateLimit(request, reply, {
            windowMs: 1000, // 1 second
            maxRequests: 30, // Telegram sends up to 30 updates per second
            keyPrefix: 'webhook'
          });
        }
      }, async (request, reply) => {
        try {
          const update = request.body as any;
          // Only log webhook summary at debug level to reduce noise
          const sanitizedUpdate = LogSanitizer.sanitizeWebhookUpdate(update);
          logger.debug('Webhook received', sanitizedUpdate);

          await bot.getBot().handleUpdate(update);
          reply.send({ ok: true });
        } catch (error) {
          logger.error('Webhook error', error);
          reply.code(404).send({ error: 'Not found' });
        }
      });
    }

    // Liveness: the process is up and the event loop is responsive. Never
    // touches dependencies — a restart would not fix a dependency outage.
    fastify.get('/live', async (_request, reply) => {
      reply.send({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    });

    // Readiness. docker-compose's healthcheck points here, so it must actually
    // verify the dependencies the join guard needs. Previously this returned a
    // hardcoded `ok`, which let a fully non-functional deployment look healthy.
    fastify.get('/health', async (_request, reply) => {
      const [dbOk, redisOk] = await Promise.all([
        AppDataSource.query('SELECT 1').then(
          () => true,
          (err) => {
            logger.warn('Health check: database unreachable', err);
            return false;
          }
        ),
        redisService.ping(),
      ]);

      const pendingMigrations = await AppDataSource.showMigrations().catch(() => true);
      const ready = dbOk && redisOk && !pendingMigrations && botStarted;

      reply.code(ready ? 200 : 503).send({
        status: ready ? 'ok' : 'degraded',
        checks: {
          database: dbOk,
          redis: redisOk,
          migrations: pendingMigrations ? 'pending' : 'applied',
          bot: botStarted,
        },
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    });

    // Start scheduler
    const scheduler = new SchedulerService(bot);
    scheduler.start();

    // Start server
    await fastify.listen({
      port: config.server.port,
      host: config.server.host,
    });

    logger.info(`Server listening on ${config.server.host}:${config.server.port}`);

    // Start bot
    await bot.start();
    botStarted = true;
    logger.info('Bot started successfully');

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      
      try {
        await bot.stop();
        scheduler.stop();
        await fastify.close();
        await redisService.close();
        await AppDataSource.destroy();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Bootstrap error', error);
    process.exit(1);
  }
}

// A rejected promise that nothing awaits used to vanish silently, leaving the
// bot running in an unknown state. Surface these loudly; an unhandled exception
// means the process state is no longer trustworthy, so exit and let the
// orchestrator restart into a clean one.
process.on('unhandledRejection', (reason) => {
  new Logger('Main').error('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
  new Logger('Main').error('Uncaught exception, exiting', error);
  process.exit(1);
});

// Start application
bootstrap().catch((error) => {
  new Logger('Main').error('Fatal bootstrap error', error);
  process.exit(1);
});
