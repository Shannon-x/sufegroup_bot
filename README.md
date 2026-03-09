# 小菲机器人 · Telegram Group Bot

> 功能完整的 Telegram 群组管理机器人，支持入群验证、内容过滤、防刷屏、等级积分、抽奖，以及 **Telegram Mini App 可视化管理面板**。

[![Release](https://img.shields.io/github/v/release/Shannon-x/sufegroup_bot)](https://github.com/Shannon-x/sufegroup_bot/releases)
[![Docker Image](https://img.shields.io/badge/ghcr.io-latest-blue)](https://ghcr.io/shannon-x/sufegroup_bot)
[![License](https://img.shields.io/github/license/Shannon-x/sufegroup_bot)](LICENSE)

---

## 功能概览

| 模块 | 功能 |
|------|------|
| **入群验证** | Cloudflare Turnstile 人机验证，超时自动踢出/禁言 |
| **内容过滤** | 内置垃圾广告识别、链接/邀请/手机号/频道转发拦截、自定义关键词 |
| **防刷屏** | 滑动窗口频率限制，自动警告/禁言/封禁 |
| **等级系统** | 发言获取经验值，自动升级，可自定义各级称号 |
| **每日签到** | 连续签到积分奖励，7天/30天里程碑加成 |
| **抽奖系统** | 等级门槛、积分花费、自动/手动开奖，群内公告 |
| **Mini App** | Telegram 内嵌可视化管理面板，5 个功能标签页 |
| **权限控制** | 每个 API 端点实时验证 Telegram 管理员身份 |
| **审计日志** | 所有管理操作记录，90 天自动清理 |

---

## Mini App 管理面板

在机器人私聊中点击 **📱 管理面板** 按钮即可打开，支持亮色/暗色主题自动切换。

| 标签页 | 功能 |
|--------|------|
| ⚙️ **设置** | 开关入群验证、调整验证时长、超时处理方式 |
| 🛡 **过滤** | 总开关、链接/邀请/手机号/频道转发开关、违规处理方式、自定义关键词管理 |
| 🌊 **刷屏** | 防刷屏总开关、消息频率预设、触发后操作、禁言时长 |
| 🏷 **称号** | 查看/添加/修改/删除等级称号，点击列表行直接填入编辑框，恢复默认 |
| 🎰 **抽奖** | 查看进行中的抽奖、立即开奖、取消抽奖、创建新抽奖 |

**权限隔离**：Mini App 只展示当前登录用户**担任管理员**的群组，其他群组不可见。

---

## 技术栈

- **运行时**：Node.js 20 + TypeScript
- **Bot 框架**：grammY
- **Web 框架**：Fastify + EJS
- **数据库**：PostgreSQL 16 + TypeORM
- **缓存**：Redis 7
- **验证**：Cloudflare Turnstile + Telegram WebApp initData HMAC
- **容器化**：Docker + Docker Compose
- **CI/CD**：GitHub Actions → ghcr.io

---

## 快速部署

### 前置要求

- Linux 服务器（1 GB+ RAM）
- Docker + Docker Compose
- 域名 + SSL 证书（Webhook 必须 HTTPS）
- Telegram Bot Token（[@BotFather](https://t.me/botfather)）
- Cloudflare Turnstile 密钥（[控制台](https://dash.cloudflare.com/)）

### 1. 拉取镜像与配置文件

```bash
mkdir sufegroup-bot && cd sufegroup-bot

# 下载生产配置
curl -LO https://raw.githubusercontent.com/Shannon-x/sufegroup_bot/master/docker-compose.prod.yml
curl -LO https://raw.githubusercontent.com/Shannon-x/sufegroup_bot/master/.env.example

cp .env.example .env
nano .env
```

### 2. 必填环境变量

```env
# Telegram 机器人
BOT_TOKEN=your_bot_token          # 从 @BotFather 获取
BOT_USERNAME=your_bot_username    # 不带 @
BOT_WEBHOOK_DOMAIN=https://your-domain.com
BOT_WEBHOOK_SECRET=random_string  # openssl rand -hex 32

# 数据库
DB_PASSWORD=strong_password       # openssl rand -hex 16

# Redis
REDIS_PASSWORD=strong_password    # openssl rand -hex 16

# Cloudflare Turnstile
TURNSTILE_SITE_KEY=your_site_key
TURNSTILE_SECRET_KEY=your_secret_key

# 安全密钥
JWT_SECRET=random_string          # openssl rand -hex 32
HMAC_SECRET=random_string         # openssl rand -hex 32
```

### 3. 启动服务

```bash
docker compose -f docker-compose.prod.yml up -d

# 查看日志
docker compose -f docker-compose.prod.yml logs -f bot

# 健康检查
curl http://localhost:8080/health
```

### 4. Nginx 反向代理

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}
```

### 从源码构建

```bash
git clone https://github.com/Shannon-x/sufegroup_bot.git
cd sufegroup_bot
cp .env.example .env
nano .env

docker compose build
docker compose up -d
```

---

## 使用说明

### 首次使用

1. 私聊机器人，发送 `/start`
2. 点击聊天框下方「**➕ 添加到群聊**」按钮，将机器人加入你的群组
3. 在群组管理员设置中将机器人设为**管理员**（需要"删除消息"和"封禁用户"权限）
4. 回到私聊，点击「**📱 管理面板**」进行配置

> ⚠️ 必须先设为管理员，否则机器人无法删除消息或封禁用户。

### 命令参考

#### 所有用户

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/checkin` | 每日签到领积分 |
| `/profile` | 查看个人等级和资料 |
| `/rank` | 活跃排行榜 |
| `/lottery list` | 查看进行中的抽奖 |
| `/join [ID]` | 参与抽奖 |

#### 管理员（群组内）

| 命令 | 说明 |
|------|------|
| `/admin` | 打开管理面板 |
| `/settings` | 查看/修改群组设置 |
| `/kick @用户 [原因]` | 踢出用户 |
| `/ban @用户 [时长] [原因]` | 封禁用户 |
| `/unban @用户` | 解封用户 |
| `/mute @用户 [时长]` | 禁言用户 |
| `/unmute @用户` | 解除禁言 |
| `/stats` | 查看群组统计 |

#### 内容过滤

| 命令 | 说明 |
|------|------|
| `/filter` | 查看过滤状态 |
| `/filter on` / `off` | 开关内容过滤 |
| `/filter add 词1 词2` | 添加自定义关键词 |
| `/filter del 词1` | 删除关键词 |
| `/filter list` | 查看关键词列表 |
| `/filter action warn\|mute\|ban` | 违规处理方式 |
| `/filter url\|invite\|phone\|forward on\|off` | 开关子规则 |
| `/filter flood on\|off` | 开关防刷屏 |
| `/filter flood limit 10 10` | 10 秒内最多 10 条 |

#### 等级与抽奖

| 命令 | 说明 |
|------|------|
| `/title 5 🌟 活跃` | 设置 Lv.5+ 称号 |
| `/title list` | 查看所有称号 |
| `/title reset` | 恢复默认称号 |
| `/lottery create <奖品> <人数> [时长] [等级] [积分]` | 创建抽奖 |
| `/draw [ID]` | 手动开奖 |
| `/lottery cancel <ID>` | 取消抽奖 |

时长格式：`5m` = 5分钟 · `2h` = 2小时 · `1d` = 1天 · 不指定 = 永久

---

## 等级系统

### 经验获取

- 发言：1–3 XP / 条（30 秒冷却）
- 每日签到：15 XP

### 默认等级称号（可在 Mini App 自定义）

| 等级 | 默认称号 | 所需 XP |
|------|---------|---------|
| 1+ | 🌱 新手 | 0 |
| 5+ | 🌟 活跃 | 1,600 |
| 10+ | ⭐ 达人 | 8,100 |
| 20+ | 🏆 元老 | 36,100 |
| 30+ | 💎 传说 | 84,100 |
| 50+ | 👑 神话 | 240,100 |

### 签到奖励

- 基础：10 积分
- 连续签到：每天额外 +2（最多 +50）
- 7 天连续：+50 积分
- 30 天连续：+200 积分

---

## CI/CD

| 触发 | 动作 |
|------|------|
| Push 到 `master` | 类型检查 + 构建 `:dev` 镜像 |
| Push tag `v*` | 类型检查 → 构建并推送 `:版本号` + `:latest` → 创建 GitHub Release |
| PR 到 `master` | 类型检查 + lint |

### 发版

```bash
# 自动递增版本并推送 tag（触发 CI/CD）
./scripts/release.sh patch   # 1.1.0 → 1.1.1
./scripts/release.sh minor   # 1.1.0 → 1.2.0
./scripts/release.sh major   # 1.1.0 → 2.0.0
```

### 服务器更新

```bash
# 拉取最新镜像并重启
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d

# 指定版本
BOT_VERSION=1.2.0 docker compose -f docker-compose.prod.yml up -d
```

---

## 运维

### 数据库备份

```bash
# 备份
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U telegram_bot telegram_bot | gzip > backup_$(date +%Y%m%d).sql.gz

# 恢复
gunzip < backup_20240101.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U telegram_bot telegram_bot
```

### 日志与调试

```bash
# 实时日志
docker compose -f docker-compose.prod.yml logs -f bot --tail=100

# 开启 debug 日志（在 .env 中设置后重启）
LOG_LEVEL=debug
docker compose -f docker-compose.prod.yml restart bot
```

---

## 安全机制

- Webhook 端点验证 Telegram IP 白名单 + Secret Token
- Cloudflare Turnstile 人机验证
- Mini App `initData` HMAC-SHA256 验证（含 1 小时时效）
- 管理员权限实时验证（`getChatMember` + Redis 缓存，防 API 滥用）
- Helmet 安全响应头 + CSP（`frame-ancestors` 限制 Mini App 嵌入来源）
- HMAC 签名验证链接防伪造
- 日志敏感信息自动脱敏

---

## 许可证

MIT — 查看 [LICENSE](LICENSE)

## 联系与支持

- Telegram: [@苏菲家宽](https://t.me/isufe2)
- 官网: [sufe.pro](https://www.sufe.pro)

---

Made with ❤️ by 林青枫
