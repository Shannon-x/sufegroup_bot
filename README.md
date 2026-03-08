# Telegram Group Management Bot (小菲机器人)

功能完善的 Telegram 群组管理机器人，提供入群验证、内容过滤、防刷屏、等级积分、抽奖等功能。

## 功能概览

| 模块 | 功能 |
|------|------|
| **入群验证** | Cloudflare Turnstile 人机验证，超时自动踢出 |
| **内容过滤** | 内置中文垃圾广告识别、链接/邀请/手机号拦截、自定义关键词 |
| **防刷屏** | 滑动窗口频率限制，自动禁言/封禁 |
| **等级系统** | 发言获取经验值，自动升级，自定义称号 |
| **每日签到** | 连续签到积分奖励，里程碑加成 |
| **抽奖系统** | 等级门槛、积分花费、自动/手动开奖 |
| **管理面板** | Inline Keyboard 按钮面板 + Telegram Mini App |
| **审计日志** | 所有管理操作记录，90 天自动清理 |

## 技术栈

- **运行时**: Node.js 20 + TypeScript
- **Bot 框架**: grammY
- **Web 框架**: Fastify
- **数据库**: PostgreSQL 16 + TypeORM
- **缓存**: Redis 7
- **验证**: Cloudflare Turnstile
- **容器化**: Docker + Docker Compose
- **CI/CD**: GitHub Actions

---

## 部署指南

### 前置要求

- Linux 服务器（1GB+ RAM）
- Docker 和 Docker Compose
- 域名 + SSL 证书（用于 Webhook）
- Telegram Bot Token（[@BotFather](https://t.me/botfather)）
- Cloudflare Turnstile 密钥（[控制台](https://dash.cloudflare.com/)）

### 方式一：Docker 部署（推荐）

#### 1. 拉取镜像

```bash
# 使用最新稳定版
docker pull ghcr.io/shannon-x/sufegroup_bot:latest

# 或指定版本
docker pull ghcr.io/shannon-x/sufegroup_bot:1.1.0
```

#### 2. 准备配置

```bash
mkdir sufegroup-bot && cd sufegroup-bot

# 下载生产配置
curl -LO https://raw.githubusercontent.com/Shannon-x/sufegroup_bot/master/docker-compose.prod.yml
curl -LO https://raw.githubusercontent.com/Shannon-x/sufegroup_bot/master/.env.example

cp .env.example .env
```

#### 3. 编辑 `.env`

```bash
nano .env
```

必须配置的项：

```env
# Telegram 机器人
BOT_TOKEN=你的bot_token            # 从 @BotFather 获取
BOT_USERNAME=你的bot用户名          # 不带 @
BOT_WEBHOOK_DOMAIN=https://你的域名 # 必须 HTTPS
BOT_WEBHOOK_SECRET=随机字符串       # openssl rand -hex 32

# 数据库
DB_PASSWORD=强密码                  # openssl rand -hex 16

# Redis
REDIS_PASSWORD=强密码              # openssl rand -hex 16

# Cloudflare Turnstile
TURNSTILE_SITE_KEY=你的site_key
TURNSTILE_SECRET_KEY=你的secret_key

# 安全密钥
JWT_SECRET=随机字符串              # openssl rand -hex 32
HMAC_SECRET=随机字符串             # openssl rand -hex 32
```

#### 4. 启动服务

```bash
docker compose -f docker-compose.prod.yml up -d
```

#### 5. 查看状态

```bash
# 查看服务状态
docker compose -f docker-compose.prod.yml ps

# 查看日志
docker compose -f docker-compose.prod.yml logs -f bot

# 健康检查
curl http://localhost:8080/health
```

### 方式二：从源码构建

```bash
git clone https://github.com/Shannon-x/sufegroup_bot.git
cd sufegroup_bot

cp .env.example .env
nano .env  # 填写配置

# 本地构建启动
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

### Nginx 反向代理

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}
```

---

## 命令参考

### 所有用户

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/checkin` | 每日签到领积分 |
| `/profile` | 查看个人等级和资料 |
| `/rank` | 活跃排行榜 |
| `/lottery list` | 查看进行中的抽奖 |
| `/join [ID]` | 参与抽奖 |

### 管理员

| 命令 | 说明 |
|------|------|
| `/admin` | 打开管理面板（按钮式） |
| `/settings` | 查看/修改群组设置 |
| `/kick @用户 [原因]` | 踢出用户 |
| `/ban @用户 [时长] [原因]` | 封禁用户 |
| `/unban @用户` | 解封用户 |
| `/mute @用户 [时长]` | 禁言用户 |
| `/unmute @用户` | 解除禁言 |
| `/stats` | 查看群组统计 |

### 内容过滤

| 命令 | 说明 |
|------|------|
| `/filter` | 查看过滤状态 |
| `/filter on` / `off` | 开关内容过滤 |
| `/filter add 词1 词2` | 添加自定义关键词 |
| `/filter del 词1` | 删除关键词 |
| `/filter list` | 查看关键词列表 |
| `/filter action warn\|mute\|ban` | 违规处理方式 |
| `/filter url\|invite\|phone\|forward on\|off` | 开关子规则 |
| `/filter flood` | 防刷屏设置 |
| `/filter flood on` / `off` | 开关防刷屏 |
| `/filter flood limit 10 10` | 10秒内最多10条 |

### 等级与抽奖

| 命令 | 说明 |
|------|------|
| `/title 5 🌟 活跃` | 设置 Lv.5+ 的自定义称号 |
| `/title list` | 查看所有称号 |
| `/title reset` | 恢复默认称号 |
| `/lottery create <奖品> <人数> [时长] [等级] [积分]` | 创建抽奖 |
| `/draw [ID]` | 手动开奖 |
| `/lottery cancel <ID>` | 取消抽奖 |

### 时长格式

`5m` = 5分钟 · `2h` = 2小时 · `1d` = 1天 · 不指定 = 永久

---

## 等级系统

### 经验获取

- 发言：1-3 XP/条（30秒冷却）
- 每日签到：15 XP

### 等级称号（可自定义）

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

## 管理面板

### Inline Keyboard 面板

在群组中发送 `/admin`，显示按钮式管理面板：

- 一键开关入群验证、内容过滤、防刷屏
- 子菜单设置验证时长、过滤规则、刷屏阈值
- 自定义等级称号、查看统计

### Mini App

管理面板底部的「📱 管理面板」按钮打开 Telegram Mini App：

- Telegram WebApp SDK 身份验证
- 仅显示当前管理员有权限的群组
- 可视化 Toggle 开关管理所有设置

---

## CI/CD

### 自动化流程

| 触发 | 动作 |
|------|------|
| Push 到 master | 类型检查 + 构建 `:dev` 镜像 |
| Push tag `v*` | 类型检查 + 构建 `:版本号` + `:latest` 镜像 + 创建 GitHub Release |
| PR 到 master | 类型检查 + lint |

### 发版

```bash
./scripts/release.sh patch   # 1.0.0 → 1.0.1
./scripts/release.sh minor   # 1.0.0 → 1.1.0
./scripts/release.sh major   # 1.0.0 → 2.0.0
```

### 服务器更新

```bash
# 更新到最新版
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d

# 指定版本
BOT_VERSION=1.2.0 docker compose -f docker-compose.prod.yml up -d
```

---

## 运维

### 备份

```bash
# 备份数据库
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U telegram_bot telegram_bot | gzip > backup_$(date +%Y%m%d).sql.gz

# 恢复
gunzip < backup_20240101.sql.gz | docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U telegram_bot telegram_bot
```

### 日志

```bash
docker compose -f docker-compose.prod.yml logs -f bot --tail=100
```

### 调试

```bash
# 启用调试日志
# .env 中设置 LOG_LEVEL=debug，然后重启
docker compose -f docker-compose.prod.yml restart bot
```

---

## 安全

- Webhook 端点验证 Telegram IP + Secret Token
- Turnstile CAPTCHA 人机验证
- HMAC 签名验证链接
- Redis 滑动窗口速率限制
- Helmet 安全头 + CSP
- 日志敏感信息脱敏
- Mini App initData HMAC 验证
- 管理员权限 Redis 缓存（防止 API 滥用）

---

## 许可证

MIT - 查看 [LICENSE](LICENSE)

## 支持

- Telegram: [@苏菲家宽](https://t.me/isufe2)
- 官网: [sufe.pro](https://www.sufe.pro)

---

Made with ❤️ by [林青枫]
