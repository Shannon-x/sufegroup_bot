# 运维手册

本文档面向部署和维护机器人的人。功能介绍、命令列表、发版流程见 [README.md](README.md)，全部环境变量见 [CONFIG.md](CONFIG.md)，Chatwoot 网关见 [docs/CHATWOOT_TELEGRAM_GATEWAY_GUIDE.md](docs/CHATWOOT_TELEGRAM_GATEWAY_GUIDE.md)。

## 目录

1. [系统架构](#系统架构)
2. [部署方式](#部署方式)
3. [Telegram 侧配置](#telegram-侧配置)
4. [启动流程与数据库迁移](#启动流程与数据库迁移)
5. [健康检查](#健康检查)
6. [日常运维](#日常运维)
7. [备份与恢复](#备份与恢复)
8. [故障排查](#故障排查)
9. [安全](#安全)

## 系统架构

```
Telegram ──HTTPS──▶ Nginx（宿主机）──▶ bot 容器 :8080（Fastify + grammY）
                                           │
                                 ┌─────────┴─────────┐
                                 ▼                   ▼
                           PostgreSQL 16          Redis 7
```

- bot 容器内监听 `8080`（`SERVER_PORT` / `PORT` 可改，默认 `8080`）。
- 设置了 `BOT_WEBHOOK_DOMAIN` 时走 Webhook 模式，端点是 `POST /telegram-webhook`；不设置则走长轮询，此时不需要公网 HTTPS，但 Mini App 和网页验证仍需要一个 HTTPS 域名。
- Webhook 请求会依次经过 Telegram IP 白名单、Secret Token 校验和限流。IP 白名单依赖 `X-Forwarded-For`，所以 Nginx 必须转发它，并且 `TRUST_PROXY` 要覆盖 Nginx 到容器的来源地址（见 [CONFIG.md](CONFIG.md#trust_proxy)）。

## 部署方式

仓库里有两份 Compose 文件，用途不同：

| 文件 | 镜像 | PostgreSQL / Redis | 端口映射 | 适用场景 |
|------|------|------|------|------|
| `docker-compose.prod.yml` | `ghcr.io/shannon-x/sufegroup_bot:${BOT_VERSION:-latest}` | 自带 `postgres` / `redis` 容器，数据在命名卷里 | `127.0.0.1:8080:8080` | 新服务器、推荐 |
| `docker-compose.yml` | 本地 `build .` | 不自带，连外部已有实例 | `8082:8080` | 已经有 1Panel 等面板托管数据库的服务器 |

### 推荐：`docker-compose.prod.yml`

```bash
mkdir sufegroup-bot && cd sufegroup-bot
curl -LO https://raw.githubusercontent.com/Shannon-x/sufegroup_bot/master/docker-compose.prod.yml
curl -LO https://raw.githubusercontent.com/Shannon-x/sufegroup_bot/master/.env.example
cp .env.example .env && nano .env

docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f bot
```

自带的 PostgreSQL 用户名和库名都是 `telegram_bot`，所以 `.env` 里保持 `DB_HOST=postgres`、`DB_USERNAME=telegram_bot`、`DB_DATABASE=telegram_bot`，`REDIS_HOST=redis`。

宿主机 Nginx 反代到 `127.0.0.1:8080`，示例配置见 README「Nginx 反向代理」一节；`nginx/conf.d/bot.conf` 是给容器化 Nginx 用的另一份参考，`proxy_pass` 指向 `bot:8080`。

### 已有数据库：`docker-compose.yml`

这份文件只起 bot 一个容器，并加入外部网络 `1panel-network`（必须事先存在）。`.env` 里的 `DB_HOST` / `REDIS_HOST` 填面板里数据库容器的名字，用户名和库名按实际创建的填。宿主机访问端口是 `8082`。

```bash
git clone https://github.com/Shannon-x/sufegroup_bot.git
cd sufegroup_bot
cp .env.example .env && nano .env
docker compose build
docker compose up -d
```

`./deploy.sh` 是交互式向导，同样操作的是这份 `docker-compose.yml`。

## Telegram 侧配置

1. 在 [@BotFather](https://t.me/botfather) 创建机器人，拿到 `BOT_TOKEN`。
2. `BOT_USERNAME` 必须和机器人真实用户名一致（不带 `@`）。验证按钮的 deep link 用的就是它，填错了用户点按钮会跳到别的账号。核对方法：
   ```bash
   curl "https://api.telegram.org/bot<BOT_TOKEN>/getMe"   # 看 result.username
   ```
3. 用 `/newapp` 创建 Mini App，URL 填 `https://<你的域名>/mini-app`，记下 Short Name 写入 `BOT_MINIAPP_SHORT_NAME`。不配置时入群验证回落到私聊里的浏览器验证；Chatwoot 网关则必须配置。
4. 把机器人拉进群并设为**管理员**，至少给「删除消息」和「封禁/限制成员」权限。机器人是管理员时能收到群里全部消息，不需要额外关闭 Group Privacy。

## 启动流程与数据库迁移

容器启动后 `src/main.ts` 按顺序做这些事，任何一步失败进程都会以退出码 1 结束，由 `restart: unless-stopped` 拉起重试：

1. **校验环境变量。** 缺必填项（如 `BOT_TOKEN`、`DB_PASSWORD`、`TURNSTILE_*`、`JWT_SECRET`），或生产环境设了 `BOT_WEBHOOK_DOMAIN` 却没设 `BOT_WEBHOOK_SECRET`、`JWT_SECRET` 不足 32 位，会直接报 `Invalid environment configuration` 并列出问题项。
2. **连接数据库。** 最多尝试 10 次，间隔指数退避（1s 起，上限 15s），用来吸收数据库比应用晚就绪的情况。10 次都失败才退出。
3. **检查迁移文件。** 一个迁移都没发现时直接报错退出，避免在空库上假装启动成功。
4. **执行迁移。** 自动运行所有未执行的迁移（`src/migrations/` 编译到 `dist/migrations/`），已执行的会被跳过。**迁移失败是致命错误，进程会退出**，不会带着残缺的表结构继续运行。
5. 启动 HTTP 服务、注册 Webhook（如配置），最后启动机器人。

所以「容器反复重启」时第一件事是看日志里最后一条 `error`：

```bash
docker compose -f docker-compose.prod.yml logs bot --tail=100
```

查看迁移执行情况：

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U telegram_bot -d telegram_bot -c "SELECT * FROM migrations ORDER BY id;"
```

需要在不启动机器人的情况下单独跑迁移（比如排查迁移报错），用一次性容器：

```bash
docker compose -f docker-compose.prod.yml run --rm bot npm run migration:run
```

## 健康检查

| 端点 | 含义 | 返回 |
|------|------|------|
| `GET /live` | 存活：进程在、事件循环有响应，不检查依赖 | 总是 `200` |
| `GET /health` | 就绪：数据库可查询、Redis 可 ping、没有待执行迁移、机器人已启动 | 全部满足 `200`，否则 `503`，`checks` 字段标明哪一项不通过 |

Compose 的 `healthcheck` 用的是 `/health`。

```bash
curl -s http://127.0.0.1:8080/health   # prod compose
curl -s http://127.0.0.1:8082/health   # docker-compose.yml
```

## 日常运维

下面以 `docker-compose.prod.yml` 为例；用 `docker-compose.yml` 的去掉 `-f` 参数即可。

```bash
# 状态 / 日志
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f bot --tail=100

# 升级到最新镜像（先备份数据库）
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d

# 固定或回退到某个版本
BOT_VERSION=2.2.6 docker compose -f docker-compose.prod.yml up -d

# 临时打开 debug 日志：.env 里设 LOG_LEVEL=debug，然后
docker compose -f docker-compose.prod.yml up -d bot
```

改了 `.env` 要用 `up -d` 重建容器，`restart` 不会重新读取 `env_file`。

日志同时输出到容器标准输出和挂载的 `./logs/` 目录，可以用 cron 清理旧文件：

```bash
0 3 * * 0 find /path/to/sufegroup-bot/logs -name "*.log" -mtime +30 -delete
```

## 备份与恢复

```bash
# 备份
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U telegram_bot telegram_bot | gzip > backup_$(date +%Y%m%d).sql.gz

# 恢复（先停 bot，避免写入）
docker compose -f docker-compose.prod.yml stop bot
gunzip < backup_20260101.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres psql -U telegram_bot telegram_bot
docker compose -f docker-compose.prod.yml start bot
```

每天定时备份可以把第一条命令放进 crontab，并用 `rsync` 同步到另一台机器。

**彻底重置数据库**（会删除所有用户、验证记录和审计日志，仅用于测试环境）：

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U telegram_bot -d telegram_bot -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
docker compose -f docker-compose.prod.yml restart bot   # 启动时会重新跑全部迁移
```

## 故障排查

**容器反复重启 / `/health` 返回 503**
看日志最后的 `error`，对照[启动流程](#启动流程与数据库迁移)判断卡在哪一步；`/health` 的 `checks` 会指明是数据库、Redis、迁移还是机器人本身。

**机器人收不到任何消息（Webhook 模式）**
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
docker compose -f docker-compose.prod.yml logs bot | grep -E "non-Telegram IP|Invalid webhook"
```
出现 `Request from non-Telegram IP` 且 IP 是 Docker 网桥地址（`172.x.x.1`），说明 `TRUST_PROXY` 没覆盖到 Nginx 的来源，或 Nginx 没转发 `X-Forwarded-For`。出现 `Invalid webhook secret token` 说明 `BOT_WEBHOOK_SECRET` 和注册 Webhook 时用的不一致。

**点验证按钮跳到别的账号 / 私聊没反应**
`BOT_USERNAME` 和真实用户名不一致，按 [Telegram 侧配置](#telegram-侧配置) 第 2 步核对，改完 `up -d` 重建容器。

**验证页面显示链接无效或已过期**
验证会话默认 10 分钟过期（`DEFAULT_VERIFY_TTL_MINUTES`）。如果刚改过 `JWT_SECRET` / `HMAC_SECRET`，之前发出的链接都会失效，让用户重新入群或由管理员 `/reverify`。

**人机验证一直失败**
核对 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`，并确认 Turnstile 控制台里允许的域名包含你的验证域名。`docker compose logs bot | grep -i turnstile` 看具体错误。

**验证成功但用户还是不能发言 / 广告删不掉**
机器人缺管理员权限。在群设置里确认它有「删除消息」和「封禁/限制成员」。

**验证页面或 Mini App 打不开**
检查 `BOT_WEBHOOK_DOMAIN` 是否带 `https://`、证书是否有效、Nginx 是否已反代到正确端口、防火墙是否开放 443。

## 安全

- `.env` 不进版本库；`BOT_TOKEN`、各类密钥只放在 `.env`，不要写进文档或聊天记录。
- 密钥用 `openssl rand -hex 32` 生成，`HMAC_SECRET` 建议独立设置（不设时回落到 `JWT_SECRET`，启动日志会警告）。
- 宿主机只开放 22 / 80 / 443；bot 端口只绑定本地（prod compose 默认如此），PostgreSQL / Redis 不对外暴露。
- 依赖更新：CI 会做依赖与密钥扫描，本地可以 `npm audit`。

**Bot Token 泄露时**：

1. 在 @BotFather 里 `/mybots` → 选机器人 → `API Token` → `Revoke current token`，拿到新 token。
2. 更新 `.env` 里的 `BOT_TOKEN`，同时轮换 `BOT_WEBHOOK_SECRET`、`JWT_SECRET`、`HMAC_SECRET`。
3. `docker compose -f docker-compose.prod.yml up -d` 重建容器。
4. 用 `grep -E "non-Telegram IP|Invalid webhook"` 检查日志里的异常请求。
