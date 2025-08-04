# 环境变量配置说明

本文档详细说明了 Telegram 群组管理机器人的所有配置项。

## 必需配置

以下配置项必须正确设置，否则机器人无法正常运行：

### BOT_TOKEN
- **说明**: Telegram Bot Token，从 @BotFather 获取
- **格式**: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`
- **获取方式**:
  1. 在 Telegram 中找到 @BotFather
  2. 发送 `/newbot` 创建新机器人
  3. 按提示设置机器人名称和用户名
  4. 获取 token

### DB_PASSWORD
- **说明**: PostgreSQL 数据库密码
- **要求**: 至少 16 位，包含大小写字母、数字和特殊字符
- **示例**: `Str0ng!P@ssw0rd#2024`

### TURNSTILE_SITE_KEY 和 TURNSTILE_SECRET_KEY
- **说明**: Cloudflare Turnstile 验证服务密钥
- **获取方式**:
  1. 访问 https://dash.cloudflare.com/
  2. 进入 Turnstile 页面
  3. 创建新站点
  4. 获取 Site Key 和 Secret Key

### JWT_SECRET
- **说明**: JWT 令牌签名密钥
- **要求**: 至少 32 位随机字符串
- **生成**: `openssl rand -hex 32`

### HMAC_SECRET
- **说明**: HMAC 签名密钥，用于验证链接
- **要求**: 至少 32 位随机字符串
- **生成**: `openssl rand -hex 32`

## 可选配置

### 服务器配置

#### NODE_ENV
- **默认值**: `development`
- **可选值**: `development`, `production`, `test`
- **说明**: 运行环境，影响日志级别和错误处理

#### PORT
- **默认值**: `3000`
- **说明**: Web 服务器端口

#### HOST
- **默认值**: `0.0.0.0`
- **说明**: 监听地址，`0.0.0.0` 表示所有网络接口

### Webhook 配置（可选）

#### BOT_WEBHOOK_DOMAIN
- **示例**: `https://bot.example.com`
- **说明**: 如果设置，将使用 webhook 模式而非轮询

#### BOT_WEBHOOK_SECRET
- **说明**: Webhook 验证密钥，建议设置以增强安全性
- **生成**: `openssl rand -hex 16`

### 数据库配置

#### DB_HOST
- **默认值**: `localhost`
- **说明**: PostgreSQL 服务器地址

#### DB_PORT
- **默认值**: `5432`
- **说明**: PostgreSQL 端口

#### DB_USERNAME
- **默认值**: `postgres`
- **说明**: 数据库用户名

#### DB_DATABASE
- **默认值**: `telegram_bot`
- **说明**: 数据库名称

### Redis 配置

#### REDIS_HOST
- **默认值**: `localhost`
- **说明**: Redis 服务器地址

#### REDIS_PORT
- **默认值**: `6379`
- **说明**: Redis 端口

#### REDIS_PASSWORD
- **默认值**: 空
- **说明**: Redis 密码（生产环境建议设置）

### 机器人行为配置

#### DEFAULT_VERIFY_TTL_MINUTES
- **默认值**: `10`
- **说明**: 新用户验证超时时间（分钟）
- **建议**: 5-30 分钟

#### DEFAULT_AUTO_ACTION
- **默认值**: `mute`
- **可选值**: `mute`, `kick`
- **说明**: 验证超时后的自动操作

#### DEFAULT_RATE_LIMIT_WINDOW_MS
- **默认值**: `60000`（1分钟）
- **说明**: 速率限制时间窗口（毫秒）

#### DEFAULT_RATE_LIMIT_MAX_REQUESTS
- **默认值**: `10`
- **说明**: 时间窗口内最大请求数

### 日志配置

#### LOG_LEVEL
- **默认值**: `info`
- **可选值**: `error`, `warn`, `info`, `debug`
- **说明**: 日志级别

#### LOG_FILE_PATH
- **默认值**: `./logs/bot.log`
- **说明**: 日志文件路径

## 生产环境配置建议

```env
# 基础配置
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# Telegram Bot
BOT_TOKEN=your_production_bot_token
BOT_WEBHOOK_DOMAIN=https://your-domain.com
BOT_WEBHOOK_SECRET=generate_a_strong_secret

# 数据库（使用 Docker 内部网络）
DB_HOST=postgres
DB_PORT=5432
DB_USERNAME=botuser
DB_PASSWORD=very_strong_password_here
DB_DATABASE=telegram_bot_prod

# Redis（使用 Docker 内部网络）
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=redis_password_here

# Turnstile
TURNSTILE_SITE_KEY=your_production_site_key
TURNSTILE_SECRET_KEY=your_production_secret_key

# 安全密钥（使用 openssl rand -hex 32 生成）
JWT_SECRET=your_64_char_jwt_secret_here
HMAC_SECRET=your_64_char_hmac_secret_here

# 机器人配置
DEFAULT_VERIFY_TTL_MINUTES=10
DEFAULT_AUTO_ACTION=kick
DEFAULT_RATE_LIMIT_WINDOW_MS=60000
DEFAULT_RATE_LIMIT_MAX_REQUESTS=5

# 日志
LOG_LEVEL=warn
LOG_FILE_PATH=/app/logs/bot.log
```

## 安全提示

1. **不要提交 .env 文件到版本控制**
2. **定期更换密钥和密码**
3. **使用强密码生成器**
4. **在生产环境中启用所有安全特性**
5. **限制数据库访问权限**
6. **使用环境变量管理工具（如 HashiCorp Vault）**

## 故障排查

如果遇到配置问题：

1. 检查所有必需的环境变量是否设置
2. 验证 Bot Token 格式是否正确
3. 确认数据库连接信息
4. 查看启动日志中的错误信息
5. 使用 `docker-compose config` 验证配置