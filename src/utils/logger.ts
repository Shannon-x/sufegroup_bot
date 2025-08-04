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

if (config.env === 'production') {
  transports.push(
    new winston.transports.File({
      filename: path.join(path.dirname(config.logging.filePath), 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: config.logging.filePath,
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