# Docker 部署说明

## 部署方式选择

根据您的服务器环境，我们提供了多种部署方式：

### 方式一：仅部署核心服务（推荐）

如果您的服务器已经有 Nginx，建议使用这种方式：

```bash
# 只启动 bot、postgres 和 redis
docker-compose up -d bot postgres redis
```

然后在您现有的 Nginx 中添加反向代理配置：

```nginx
# 在您现有的 nginx 配置中添加
server {
    listen 443 ssl http2;
    server_name bot.yourdomain.com;
    
    # SSL 证书配置（使用您现有的证书）
    ssl_certificate /path/to/your/cert.pem;
    ssl_certificate_key /path/to/your/key.pem;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # Telegram webhook 专用路径
    location /telegram-webhook {
        # 只允许 Telegram 服务器 IP
        allow 149.154.160.0/20;
        allow 91.108.4.0/22;
        allow 91.108.8.0/22;
        allow 91.108.12.0/22;
        allow 91.108.16.0/22;
        allow 91.108.56.0/22;
        allow 95.161.64.0/20;
        deny all;
        
        proxy_pass http://localhost:3000;
        proxy_set_header X-Telegram-Bot-Api-Secret-Token $http_x_telegram_bot_api_secret_token;
    }
}
```

### 方式二：使用容器版 Nginx（非默认端口）

如果您想使用容器版的 Nginx，已配置为使用 8080/8443 端口：

```bash
# 使用生产环境配置文件
docker-compose -f docker-compose.prod.yml up -d
```

访问地址：
- HTTP: http://your-server:8080
- HTTPS: https://your-server:8443

### 方式三：仅使用开发模式

开发和测试时，可以直接使用基础配置：

```bash
# 使用默认 docker-compose.yml
docker-compose up -d
```

Bot 将直接在 3000 端口提供服务。

## 部署步骤

### 1. 准备配置文件

```bash
# 复制并编辑环境变量
cp .env.example .env
nano .env

# 必须配置的项：
# - BOT_TOKEN
# - DB_PASSWORD  
# - TURNSTILE_SITE_KEY
# - TURNSTILE_SECRET_KEY
# - JWT_SECRET
# - HMAC_SECRET
```

### 2. 选择部署方式

**推荐：仅部署核心服务**
```bash
# 构建镜像
docker-compose build

# 启动核心服务
docker-compose up -d bot postgres redis

# 查看日志
docker-compose logs -f bot
```

### 3. 运行数据库迁移

```bash
# 等待数据库启动完成
sleep 10

# 运行迁移
docker-compose exec bot npm run migration:run
```

### 4. 配置 Webhook（可选）

如果使用 Webhook 模式而非轮询模式：

```bash
# 在 .env 中设置
BOT_WEBHOOK_DOMAIN=https://bot.yourdomain.com
BOT_WEBHOOK_SECRET=your_webhook_secret
```

## 端口说明

默认端口配置：
- **3000**: Bot 主服务（可通过 PORT 环境变量修改）
- **5432**: PostgreSQL 数据库
- **6379**: Redis 缓存
- **8080**: 容器 Nginx HTTP（生产环境配置）
- **8443**: 容器 Nginx HTTPS（生产环境配置）

## 健康检查

```bash
# 检查服务状态
docker-compose ps

# 健康检查端点
curl http://localhost:3000/health

# 查看资源使用
docker stats
```

## 常用命令

```bash
# 查看日志
docker-compose logs -f [service]

# 重启服务
docker-compose restart bot

# 停止所有服务
docker-compose down

# 停止并删除数据
docker-compose down -v

# 更新部署
git pull
docker-compose build bot
docker-compose up -d bot
```

## 与现有 Nginx 集成

如果您使用自己的 Nginx，建议：

1. Bot 服务只监听本地：在 .env 中设置 `HOST=127.0.0.1`
2. 数据库和 Redis 也只监听本地网络
3. 通过您的 Nginx 反向代理到 Bot 服务

这样可以：
- 利用现有的 SSL 证书
- 统一管理所有 Web 服务
- 更好的安全性（服务不直接暴露）

## 注意事项

1. 确保防火墙规则正确配置
2. 如果使用 Webhook，域名必须有有效的 SSL 证书
3. 定期备份数据库：`./backup.sh`
4. 监控磁盘空间，特别是日志目录