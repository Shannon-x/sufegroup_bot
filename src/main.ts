import 'reflect-metadata';
import Fastify from 'fastify';
import fastifyView from '@fastify/view';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import ejs from 'ejs';
import path from 'path';
import { AppDataSource } from './config/database';
import { config } from './config/config';
import { Logger } from './utils/logger';
import { TelegramBot } from './services/TelegramBot';
import { VerificationController } from './controllers/VerificationController';
import { SchedulerService } from './services/SchedulerService';
import { RateLimitMiddleware } from './middleware/RateLimitMiddleware';

async function bootstrap() {
  const logger = new Logger('Main');

  try {
    // Initialize database
    logger.info('Connecting to database...');
    await AppDataSource.initialize();
    logger.info('Database connected');

    // Initialize Fastify
    const fastify = Fastify({
      logger: false,
      trustProxy: true,
    });

    // Register plugins
    await fastify.register(fastifyHelmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://challenges.cloudflare.com'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          frameSrc: ['https://challenges.cloudflare.com'],
          connectSrc: ["'self'", 'https://challenges.cloudflare.com'],
          imgSrc: ["'self'", 'data:', 'https:'],
          fontSrc: ["'self'", 'https:', 'data:'],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          childSrc: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      },
      noSniff: true,
      originAgentCluster: true,
      permittedCrossDomainPolicies: false,
      referrerPolicy: { policy: "no-referrer" },
      xssFilter: true,
    });

    await fastify.register(fastifyCors, {
      origin: false,
    });

    await fastify.register(fastifyCookie);

    await fastify.register(fastifyRateLimit, {
      global: false, // We'll use custom rate limiting
    });

    await fastify.register(fastifyStatic, {
      root: path.join(__dirname, '..', 'public'),
      prefix: '/',
    });

    await fastify.register(fastifyView, {
      engine: {
        ejs,
      },
      root: path.join(__dirname, '..', 'views'),
    });

    // Initialize bot
    logger.info('Initializing Telegram bot...');
    const bot = new TelegramBot();

    // Initialize controllers
    const verificationController = new VerificationController(bot);
    await verificationController.register(fastify);

    // Setup webhook endpoint if configured
    if (config.bot.webhookDomain) {
      const rateLimiter = new RateLimitMiddleware();
      
      fastify.post('/telegram-webhook', {
        preHandler: async (request, reply) => {
          // Verify webhook secret
          const secret = request.headers['x-telegram-bot-api-secret-token'];
          if (secret !== config.bot.webhookSecret) {
            reply.code(401).send({ error: 'Unauthorized' });
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
          logger.info('Webhook received', {
            updateId: update.update_id,
            hasMessage: !!update.message,
            hasChatMember: !!update.chat_member,
            hasCallbackQuery: !!update.callback_query,
            messageText: update.message?.text,
            newChatMembers: update.message?.new_chat_members?.length || 0
          });
          
          await bot.getBot().handleUpdate(update);
          reply.send({ ok: true });
        } catch (error) {
          logger.error('Webhook error', error);
          reply.code(500).send({ error: 'Internal server error' });
        }
      });
    }

    // Health check endpoint
    fastify.get('/health', async (request, reply) => {
      reply.send({
        status: 'ok',
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
    logger.info('Bot started successfully');

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      
      try {
        await bot.stop();
        scheduler.stop();
        await fastify.close();
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

// Start application
bootstrap();