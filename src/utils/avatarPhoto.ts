import { Api } from 'grammy';
import { config } from '../config/config';
import { redisService } from '../services/RedisService';
import { Logger } from './logger';

const logger = new Logger('AvatarPhoto');

const POSITIVE_TTL = 6 * 60 * 60; // 6h cache for a resolved photo
const NEGATIVE_TTL = 30 * 60;     // 30m cache for "no photo" (avoid hammering Bot API)
const NONE = '0';                 // sentinel for "user has no usable profile photo"
const MAX_BYTES = 256 * 1024;     // safety cap on the embedded image size

/**
 * Resolve a user's real Telegram profile photo as a self-contained data URI.
 *
 * Direct-link Mini Apps usually do NOT receive `initDataUnsafe.user.photo_url`
 * (Telegram only sends it for attachment-menu launches), so we fetch it
 * server-side via getUserProfilePhotos → getFile and proxy the bytes as a
 * base64 data URI — this keeps the bot token (embedded in the file URL) on the
 * server. Result is cached in Redis. Returns null when the user has no photo,
 * hides it from the bot, or on any transient failure (caller falls back to the
 * initial-letter avatar).
 */
export async function getUserAvatarDataUrl(api: Api, userId: string | number): Promise<string | null> {
  const cacheKey = `avatar_durl:${userId}`;

  try {
    const cached = await redisService.get(cacheKey);
    if (cached !== null) return cached === NONE ? null : cached;
  } catch {
    // cache read is best-effort
  }

  let dataUrl: string | null = null;
  try {
    const profile = await api.getUserProfilePhotos(Number(userId), { limit: 1 });
    const sizes = profile.photos?.[0];
    if (sizes && sizes.length > 0) {
      // Prefer a ~160px rendition for a small avatar; fall back to the largest.
      const size = sizes.find((s) => s.width >= 120) ?? sizes[sizes.length - 1];
      const file = await api.getFile(size.file_id);
      if (file.file_path) {
        const url = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
        const resp = await fetch(url);
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length > 0 && buf.length <= MAX_BYTES) {
            dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
          }
        }
      }
    }
  } catch (err) {
    // Transient failure (network / privacy / rate limit): don't cache, just
    // fall back to the initial avatar this time.
    logger.debug('getUserAvatarDataUrl failed', err);
    return null;
  }

  try {
    await redisService.set(cacheKey, dataUrl ?? NONE, dataUrl ? POSITIVE_TTL : NEGATIVE_TTL);
  } catch {
    // cache write is best-effort
  }
  return dataUrl;
}
