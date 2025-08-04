# Telegram Group Management Bot (小菲机器人)

一个功能强大的 Telegram 群组管理机器人，具有新成员验证、管理员命令、防机器人等功能。

## 🚀 功能特性

### 核心功能
- 🔐 **新成员验证**: 使用 Cloudflare Turnstile 进行人机验证
- 👮 **管理员命令**: 封禁、踢出、禁言等管理功能
- 🤖 **防机器人保护**: 自动限制未验证用户
- 📊 **审计日志**: 记录所有管理操作
- ⚡ **高性能**: 基于 Node.js + TypeScript + Grammy 框架
- 🎨 **现代化UI**: 霓虹风格验证界面

### 管理命令
- `/ban @username [时长] [原因]` - 封禁用户
- `/unban @username` - 解封用户
- `/kick @username [原因]` - 踢出用户
- `/mute @username [时长] [原因]` - 禁言用户
- `/unmute @username` - 解除禁言
- `/settings` - 群组设置
- `/stats` - 查看统计信息
- `/help` - 帮助信息

### 时长格式
- `5m` = 5分钟
- `2h` = 2小时  
- `1d` = 1天
- 不指定 = 永久

## 📋 技术栈

- **后端**: Node.js + TypeScript
- **框架**: Grammy (Telegram Bot Framework)
- **数据库**: PostgreSQL + TypeORM
- **缓存**: Redis
- **Web框架**: Fastify
- **容器化**: Docker + Docker Compose
- **验证**: Cloudflare Turnstile

## 🛠️ 快速部署指南

### 前置要求

1. **服务器要求**:
   - Linux 服务器 (推荐 Ubuntu 20.04+)
   - 至少 1GB RAM
   - Docker 和 Docker Compose
   - 域名和 SSL 证书（用于 Webhook）

2. **必需的服务**:
   - Telegram Bot Token (从 [@BotFather](https://t.me/botfather) 获取)
   - Cloudflare 账号 (用于 Turnstile)

### 部署步骤

#### 1. 克隆项目

```bash
git clone https://github.com/yourusername/telegram-group-bot.git
cd telegram-group-bot
```

#### 2. 配置环境变量

```bash
# 复制示例配置文件
cp .env.example .env

# 编辑配置文件
nano .env
```

必须配置的环境变量：
- `BOT_TOKEN`: Telegram Bot Token
- `BOT_USERNAME`: 机器人用户名（不带@）
- `BOT_WEBHOOK_DOMAIN`: 你的域名（需要HTTPS）
- `TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET_KEY`: Cloudflare Turnstile 密钥
- 数据库和 Redis 密码

#### 3. 生成安全密钥

```bash
# 生成 JWT_SECRET
openssl rand -hex 32

# 生成 ENCRYPTION_KEY (必须是32个字符)
openssl rand -hex 16

# 生成 BOT_WEBHOOK_SECRET
openssl rand -hex 32
```

#### 4. 使用 Docker Compose 部署

```bash
# 运行交互式部署脚本（推荐）
./deploy.sh

# 或者手动部署
docker compose up -d

# 查看日志
docker compose logs -f

# 仅查看机器人日志
docker compose logs -f bot
```

部署脚本提供以下选项：
- **完整部署**: 包含 PostgreSQL、Redis 和 Bot
- **仅机器人**: 使用外部数据库和 Redis
- **开发模式**: 前台运行，便于调试
- **更新部署**: 仅更新机器人代码

#### 5. 配置 Nginx 反向代理（如果需要）

创建 `/etc/nginx/sites-available/telegram-bot`：

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # Webhook 路径
    location /telegram-webhook {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Telegram-Bot-Api-Secret-Token $http_x_telegram_bot_api_secret_token;
    }

    # 验证页面
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

启用站点：

```bash
sudo ln -s /etc/nginx/sites-available/telegram-bot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Docker Compose 配置说明

项目包含的 `docker-compose.yml` 会启动以下服务：

1. **bot**: 主应用程序
2. **postgres**: PostgreSQL 数据库
3. **redis**: Redis 缓存

如果你的服务器已经有 PostgreSQL 或 Redis，可以：

1. 修改 `.env` 中的连接信息指向现有服务
2. 仅启动机器人服务：`docker compose up -d bot`

## 🔧 配置说明

### 创建 Telegram 机器人

1. 在 Telegram 中找到 [@BotFather](https://t.me/botfather)
2. 发送 `/newbot` 创建新机器人
3. 设置机器人名称和用户名
4. 保存获得的 Bot Token
5. 发送 `/setcommands` 设置命令列表：
   ```
   help - 显示帮助信息
   settings - 群组设置
   stats - 查看统计信息
   ban - 封禁用户
   unban - 解封用户
   kick - 踢出用户
   mute - 禁言用户
   unmute - 解除禁言
   ```

### 配置 Cloudflare Turnstile

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 导航到 Turnstile 页面
3. 创建新的站点
4. 域名填写你的验证页面域名
5. 获取 Site Key 和 Secret Key

### 设置机器人权限

将机器人添加到群组后，需要授予以下权限：
- 删除消息
- 限制用户
- 邀请用户（可选）

## 📊 维护和监控

### 查看日志

```bash
# 实时查看所有服务日志
docker compose logs -f

# 查看特定服务日志
docker compose logs -f bot
docker compose logs -f postgres

# 查看最近100行日志
docker compose logs --tail=100 bot
```

### 备份数据库

```bash
# 创建备份目录
mkdir -p backups

# 备份数据库
docker compose exec postgres pg_dump -U telegram_bot telegram_bot | gzip > backups/backup_$(date +%Y%m%d_%H%M%S).sql.gz

# 恢复数据库
gunzip < backups/backup_20240101_120000.sql.gz | docker compose exec -T postgres psql -U telegram_bot telegram_bot
```

### 更新机器人

```bash
# 拉取最新代码
git pull origin main

# 重新构建镜像
docker compose build

# 重启服务
docker compose down
docker compose up -d
```

### 健康检查

```bash
# 检查服务状态
docker compose ps

# 检查健康状态
curl http://localhost:8080/health

# 查看资源使用
docker stats
```

## 🚨 故障排除

### 常见问题

1. **Webhook 无法连接**
   - 确保域名已正确解析
   - 检查 SSL 证书是否有效
   - 验证防火墙规则
   - 检查 Nginx 配置

2. **机器人无响应**
   - 检查 BOT_TOKEN 是否正确
   - 查看日志中的错误信息
   - 确认网络连接正常
   - 检查是否正确设置了 Webhook

3. **数据库连接失败**
   - 确认数据库服务正在运行
   - 检查连接字符串
   - 验证用户权限
   - 检查防火墙设置

4. **验证页面错误**
   - 检查 Turnstile 配置
   - 确认域名可以访问
   - 查看浏览器控制台
   - 检查 CSP 头设置

### 调试技巧

1. **启用调试日志**
   ```bash
   # 修改 .env
   LOG_LEVEL=debug
   
   # 重启服务
   docker compose restart bot
   ```

2. **测试数据库连接**
   ```bash
   docker compose exec postgres psql -U telegram_bot -d telegram_bot
   ```

3. **测试 Redis 连接**
   ```bash
   docker compose exec redis redis-cli ping
   ```

## 🔒 安全建议

1. **使用强密码**: 为所有服务设置强密码
2. **定期更新**: 保持系统和依赖更新
3. **限制访问**: 配置防火墙规则
4. **备份数据**: 定期备份重要数据
5. **监控日志**: 定期检查异常活动
6. **HTTPS**: 始终使用 HTTPS
7. **密钥轮换**: 定期更换敏感密钥

## 🤝 贡献指南

欢迎贡献代码！请遵循以下步骤：

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情

## 📞 支持

- Issues: [GitHub Issues](https://github.com/yourusername/telegram-group-bot/issues)
- Telegram: [@your_support_group](https://t.me/your_support_group)

---

Made with ❤️ by [Your Name]