import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { GroupService } from '../services/GroupService';
import { ContentFilterService, DEFAULT_FILTER_CONFIG } from '../services/ContentFilterService';
import { LevelService } from '../services/LevelService';
import { Logger } from '../utils/logger';
import { config } from '../config/config';
import { TelegramBot } from '../services/TelegramBot';

export class MiniAppController {
  private groupService: GroupService;
  private contentFilter: ContentFilterService;
  private levelService: LevelService;
  private bot: TelegramBot;
  private logger: Logger;

  constructor(bot: TelegramBot) {
    this.groupService = new GroupService();
    this.contentFilter = new ContentFilterService();
    this.levelService = new LevelService();
    this.bot = bot;
    this.logger = new Logger('MiniAppController');
  }

  async register(fastify: FastifyInstance) {
    // Serve Mini App page
    fastify.get('/mini-app', async (_request, reply) => {
      return reply.view('mini-app', {
        botUsername: config.bot.username || 'bot',
      });
    });

    // API: Get admin's groups
    fastify.post<{ Body: { initData: string } }>('/api/admin/groups', async (request, reply) => {
      const userId = this.validateInitData(request.body?.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const groups = await this.groupService.getAdminGroups(userId, this.bot.getBot().api);
      return reply.send({
        groups: groups.map(g => ({
          id: g.id,
          title: g.title,
          username: g.username,
        })),
      });
    });

    // API: Get group settings
    fastify.post<{ Body: { initData: string; groupId: string } }>('/api/admin/settings', async (request, reply) => {
      const userId = this.validateInitData(request.body?.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { groupId } = request.body;
      const isAdmin = await this.groupService.isAdminCached(Number(groupId), Number(userId), this.bot.getBot().api);
      if (!isAdmin) return reply.code(403).send({ error: 'Not admin of this group' });

      const settings = await this.groupService.getSettings(groupId);
      if (!settings) return reply.code(404).send({ error: 'Group not found' });

      const filterConfig = this.contentFilter.getFilterConfig(settings.customSettings);
      const customTitles = settings.customSettings?.customTitles || null;

      return reply.send({
        verificationEnabled: settings.verificationEnabled,
        ttlMinutes: settings.ttlMinutes,
        autoAction: settings.autoAction,
        filter: filterConfig,
        customTitles: customTitles || LevelService.getDefaultTitles(),
      });
    });

    // API: Update group settings
    fastify.post<{ Body: { initData: string; groupId: string; updates: any } }>('/api/admin/settings/update', async (request, reply) => {
      const userId = this.validateInitData(request.body?.initData);
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { groupId, updates } = request.body;
      const isAdmin = await this.groupService.isAdminCached(Number(groupId), Number(userId), this.bot.getBot().api);
      if (!isAdmin) return reply.code(403).send({ error: 'Not admin of this group' });

      const settings = await this.groupService.getSettings(groupId);
      if (!settings) return reply.code(404).send({ error: 'Group not found' });

      // Whitelist allowed fields
      const allowed: Record<string, boolean> = {
        verificationEnabled: true,
        ttlMinutes: true,
        autoAction: true,
      };

      const safeUpdates: any = {};
      for (const key of Object.keys(updates)) {
        if (allowed[key]) safeUpdates[key] = updates[key];
      }

      // Handle nested updates
      if (updates.filter) {
        const cs = settings.customSettings || {};
        cs.filter = { ...this.contentFilter.getFilterConfig(cs), ...updates.filter };
        safeUpdates.customSettings = cs;
      }
      if (updates.customTitles) {
        const cs = safeUpdates.customSettings || settings.customSettings || {};
        cs.customTitles = updates.customTitles;
        safeUpdates.customSettings = cs;
      }

      await this.groupService.updateSettings(groupId, safeUpdates);
      return reply.send({ success: true });
    });
  }

  /**
   * Validate Telegram WebApp initData using bot token.
   * Returns userId if valid, null otherwise.
   */
  private validateInitData(initData: string | undefined): string | null {
    if (!initData) return null;

    try {
      const params = new URLSearchParams(initData);
      const hash = params.get('hash');
      if (!hash) return null;

      params.delete('hash');
      const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

      const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(config.bot.token)
        .digest();

      const computedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

      if (computedHash !== hash) return null;

      // Check auth_date is not too old (1 hour)
      const authDate = parseInt(params.get('auth_date') || '0', 10);
      if (Date.now() / 1000 - authDate > 3600) return null;

      const user = params.get('user');
      if (!user) return null;

      const userData = JSON.parse(user);
      return userData.id?.toString() || null;
    } catch {
      return null;
    }
  }
}
