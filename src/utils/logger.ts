import winston from 'winston';
import path from 'path';
import { config } from '../config/config';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }),
];

// Size-capped rotation. The file transports had no limit, so bot.log grew
// until the disk filled — and near-miss / spam-report samples now make it grow
// faster. winston rolls to bot1.log, bot2.log… and drops the oldest.
const LOG_FILE_MAX_BYTES = 20 * 1024 * 1024;
const LOG_FILE_KEEP = 10;

if (config.env === 'production') {
  transports.push(
    new winston.transports.File({
      filename: path.join(path.dirname(config.logging.filePath), 'error.log'),
      level: 'error',
      maxsize: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_KEEP,
      tailable: true,
    }),
    new winston.transports.File({
      filename: config.logging.filePath,
      maxsize: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_KEEP,
      // Newest entries always stay in bot.log, so `tail -f logs/bot.log`
      // keeps working across rotations.
      tailable: true,
    })
  );
}

export const logger = winston.createLogger({
  level: config.logging.level,
  format: logFormat,
  transports,
});

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  info(message: string, meta?: any) {
    logger.info(message, { context: this.context, ...meta });
  }

  error(message: string, error?: Error | any, meta?: any) {
    logger.error(message, { context: this.context, error: error?.stack || error, ...meta });
  }

  warn(message: string, meta?: any) {
    logger.warn(message, { context: this.context, ...meta });
  }

  debug(message: string, meta?: any) {
    logger.debug(message, { context: this.context, ...meta });
  }
}